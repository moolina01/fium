import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { addFulfillmentEvent, cancelOrderFulfillments, type FulfillmentEventStatus } from "./fulfillment.server";
import { logError, logInfo } from "./logger.server";

export const UBER_CANCELED_REASON =
  "Uber Direct canceló el envío (normalmente porque no encontró un courier disponible). Vuelve a despacharlo.";

const VALID_STATUSES = ["pending", "pickup", "pickup_complete", "dropoff", "delivered", "canceled", "returned"];

// Estados de Uber → eventos de fulfillment de Shopify, para que la línea de
// tiempo del pedido refleje el avance del envío.
const FULFILLMENT_EVENT_BY_STATUS: Record<string, FulfillmentEventStatus> = {
  pickup_complete: "IN_TRANSIT",
  dropoff: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
};

type DeliveryRef = { id: string; shop: string; orderId: string; orderNumber: string; status: string };

/**
 * Aplica a un delivery el estado que reporta Uber (vía webhook o consultando la
 * API). Única implementación para el webhook, el dashboard y el detalle del envío.
 * Devuelve el estado con el que queda el delivery.
 */
export async function applyUberStatus(
  delivery: DeliveryRef,
  live: { status: string; trackingUrl?: string | null },
  context: string
): Promise<string> {
  if (!VALID_STATUSES.includes(live.status) || live.status === delivery.status) return delivery.status;

  if (live.status === "canceled") {
    // Cancelado por la tienda: ya quedó "canceled" antes de llamar a Uber.
    if (delivery.status === "canceled" || delivery.status === "failed") return delivery.status;
    await handleUberCancellation(delivery, context);
    return "failed";
  }

  await db.delivery.update({
    where: { id: delivery.id },
    data: { status: live.status, ...(live.trackingUrl ? { uberTrackingUrl: live.trackingUrl } : {}) },
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
  context: string
): Promise<void> {
  await db.delivery.update({
    where: { id: delivery.id },
    data: { status: "failed", failureReason: UBER_CANCELED_REASON },
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
