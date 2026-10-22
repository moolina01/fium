import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { addFulfillmentEvent, cancelOrderFulfillments, type FulfillmentEventStatus } from "./fulfillment.server";
import { logError, logInfo } from "./logger.server";

export const UBER_CANCELED_REASON =
  "Uber Direct canceló el envío (normalmente porque no encontró un courier disponible). Vuelve a despacharlo.";

// Motivos de Uber → español. Si llega un código desconocido se muestra legible
// ("item_damaged" → "item damaged") en vez de esconderlo.
const ISSUE_REASONS_ES: Array<[RegExp, string]> = [
  [/no.?courier|courier.?unavailable|couriers?_not_available|no_driver/i, "no había conductores disponibles"],
  [/customer.*(unavailable|not.?available|no.?show|unreachable|not.?respond)/i, "el cliente no estaba disponible o no contestó"],
  [/customer.*(refus|reject)/i, "el cliente rechazó el pedido"],
  [/cannot.?find.*address|address.?not.?found/i, "el conductor no encontró la dirección del cliente"],
  [/(address|location).*(wrong|invalid|incorrect|not.?found|inaccessible|issue)|cannot.?access|unable.?to.?access/i, "el conductor no pudo llegar a la dirección"],
  [/too.?(large|big|heavy)|oversize|overweight|does.?not.?fit|item.?size/i, "el pedido era muy grande o pesado para el conductor"],
  [/(store|merchant).*(closed|not.?ready|unavailable)|order.?not.?ready|pickup.?(issue|failed)/i, "el conductor no pudo retirar el pedido en tu tienda"],
  [/damag/i, "el pedido se dañó"],
  [/unsafe|safety/i, "el conductor reportó un problema de seguridad"],
];

export function describeIssueReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  for (const [re, es] of ISSUE_REASONS_ES) if (re.test(reason)) return es;
  return reason.replace(/[_-]+/g, " ").trim().toLowerCase() || null;
}

/** Texto para la tienda cuando Uber cancela el envío. */
export function uberCanceledReason(reason: string | null | undefined): string {
  const es = describeIssueReason(reason);
  return es ? `Uber Direct canceló el envío: ${es}. Vuelve a despacharlo.` : UBER_CANCELED_REASON;
}

/** Texto para la tienda cuando Uber devuelve el pedido. */
export function uberReturnedReason(reason: string | null | undefined): string {
  const es = describeIssueReason(reason);
  return es
    ? `El conductor no pudo entregar el pedido (${es}) y lo devolvió a tu tienda.`
    : "El conductor no pudo entregar el pedido y lo devolvió a tu tienda.";
}

const VALID_STATUSES = ["pending", "pickup", "pickup_complete", "dropoff", "delivered", "canceled", "returned"];

// Estados de Uber → eventos de fulfillment de Shopify, para que la línea de
// tiempo del pedido refleje el avance del envío.
const FULFILLMENT_EVENT_BY_STATUS: Record<string, FulfillmentEventStatus> = {
  pickup_complete: "IN_TRANSIT",
  dropoff: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
};

type DeliveryRef = { id: string; shop: string; orderId: string; orderNumber: string; status: string };

type LiveDelivery = {
  status: string;
  trackingUrl?: string | null;
  pickupEta?: string | null;
  dropoffEta?: string | null;
  issueReason?: string | null;
  issueDebug?: Record<string, unknown>;
  courier?: {
    name: string;
    phone: string;
    vehicleType: string;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleColor?: string;
  } | null;
};

// Uber informa el color en inglés; se traducen los más comunes.
const COLORS_ES: Record<string, string> = {
  white: "blanco", black: "negro", silver: "plateado", gray: "gris", grey: "gris",
  red: "rojo", blue: "azul", green: "verde", yellow: "amarillo", orange: "naranjo",
  brown: "café", beige: "beige", gold: "dorado", purple: "morado",
};
const VEHICLE_TYPES_ES: Record<string, string> = {
  car: "Auto", motorcycle: "Moto", scooter: "Moto", bicycle: "Bicicleta", walker: "A pie",
};

/** "Toyota Prius blanco", o el tipo de vehículo ("Moto") si Uber no da marca/modelo. */
export function describeVehicle(courier: NonNullable<LiveDelivery["courier"]>): string | null {
  const makeModel = [courier.vehicleMake, courier.vehicleModel].filter(Boolean).join(" ").trim();
  if (makeModel) {
    const color = courier.vehicleColor ? COLORS_ES[courier.vehicleColor.toLowerCase()] ?? courier.vehicleColor.toLowerCase() : "";
    return [makeModel, color].filter(Boolean).join(" ");
  }
  return VEHICLE_TYPES_ES[courier.vehicleType?.toLowerCase()] ?? (courier.vehicleType || null);
}

function liveDetails(live: LiveDelivery) {
  const toDate = (iso?: string | null) => (iso ? new Date(iso) : null);
  return {
    pickupEta: toDate(live.pickupEta),
    dropoffEta: toDate(live.dropoffEta),
    courierName: live.courier?.name || null,
    courierPhone: live.courier?.phone || null,
    courierVehicle: live.courier ? describeVehicle(live.courier) : null,
    liveSyncedAt: new Date(),
    ...(live.trackingUrl ? { uberTrackingUrl: live.trackingUrl } : {}),
  };
}

/**
 * Aplica a un delivery lo que reporta Uber (vía webhook o consultando la API):
 * estado, ETA y conductor. Única implementación para el webhook, el dashboard y
 * el detalle del envío. Devuelve el estado con el que queda el delivery.
 */
export async function applyUberStatus(
  delivery: DeliveryRef,
  live: LiveDelivery,
  context: string
): Promise<string> {
  const details = liveDetails(live);

  if (!VALID_STATUSES.includes(live.status) || live.status === delivery.status) {
    // Mismo estado: igual se guardan ETA/conductor, que cambian mientras avanza.
    await db.delivery.update({ where: { id: delivery.id }, data: details });
    return delivery.status;
  }

  if (live.status === "canceled" || live.status === "returned") {
    // Para confirmar en qué campo manda Uber el motivo (ver extractIssueReason).
    logInfo(context, `Uber informó envío ${live.status}`, {
      shop: delivery.shop, orderNumber: delivery.orderNumber,
      issueReason: live.issueReason ?? null, uber: live.issueDebug ?? {},
    });
  }

  if (live.status === "canceled") {
    // Cancelado por la tienda: ya quedó "canceled" antes de llamar a Uber.
    if (delivery.status === "canceled" || delivery.status === "failed") return delivery.status;
    await handleUberCancellation(delivery, context, live.issueReason);
    return "failed";
  }

  await db.delivery.update({
    where: { id: delivery.id },
    data: {
      status: live.status,
      ...details,
      // Devuelto: queda el motivo para el aviso del panel y el detalle del envío.
      ...(live.status === "returned" && { failureReason: uberReturnedReason(live.issueReason) }),
    },
  });

  // Solo al entrar a un estado nuevo (ya filtrado arriba), para no duplicar eventos.
  const fulfillmentStatus = FULFILLMENT_EVENT_BY_STATUS[live.status];
  if (fulfillmentStatus) {
    try {
      const { admin } = await unauthenticated.admin(delivery.shop);
      await addFulfillmentEvent(admin, delivery.orderId, fulfillmentStatus, `${context}/fulfillment-event`);
    } catch (err) {
      logError(`${context}/fulfillment-event`, err, { deliveryId: delivery.id, status: live.status });
    }
  }
  return live.status;
}

/**
 * Uber canceló el envío por su cuenta (ej. no encontró courier). Las cancelaciones
 * hechas por la tienda desde el dashboard ya quedan en "canceled" antes de llamar
 * a Uber, así que nunca llegan aquí.
 *
 * Se marca como "failed" para que la orden reaparezca en "Por despachar" con la
 * alerta y el motivo (mismo flujo que un auto-despacho fallido), y se cancela el
 * fulfillment en Shopify para que la orden deje de figurar como enviada.
 */
export async function handleUberCancellation(
  delivery: { id: string; shop: string; orderId: string; orderNumber: string },
  context: string,
  issueReason?: string | null
): Promise<void> {
  await db.delivery.update({
    where: { id: delivery.id },
    data: { status: "failed", failureReason: uberCanceledReason(issueReason) },
  });
  logInfo(context, "Uber canceló el envío — vuelve a 'Por despachar'", {
    shop: delivery.shop,
    orderNumber: delivery.orderNumber,
  });

  try {
    const { admin } = await unauthenticated.admin(delivery.shop);
    await cancelOrderFulfillments(admin, delivery.orderId, context);
  } catch (err) {
    logError(context, err, { deliveryId: delivery.id });
  }
}
