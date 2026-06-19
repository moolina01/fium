import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { verifyUberSignature, type UberWebhookEvent } from "../services/uber-direct.server";
import { decrypt } from "../lib/crypto.server";
import { logError, logDebug } from "../lib/logger.server";
import { addFulfillmentEvent, type FulfillmentEventStatus } from "../lib/fulfillment.server";

const VALID_STATUSES = ["pending", "pickup", "pickup_complete", "dropoff", "delivered", "canceled", "returned"];

// Mapea los estados de Uber a eventos de fulfillment de Shopify, para que la
// línea de tiempo del pedido refleje el avance del envío.
const FULFILLMENT_EVENT_BY_STATUS: Record<string, FulfillmentEventStatus> = {
  pickup_complete: "IN_TRANSIT",
  dropoff: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const rawBody = await request.text();
  const signature = request.headers.get("X-Postmates-Signature");

  // El webhook no identifica la tienda por sí mismo. Lo resolvemos por el
  // customer_id del payload (cada tienda tiene el suyo) y verificamos la firma
  // con el client_secret de ESA tienda.
  let event: UberWebhookEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }

  const customerId = event.customer_id;
  if (!customerId) {
    logError("uber-webhook", "payload sin customer_id — rechazado");
    return new Response(null, { status: 401 });
  }

  const store = await db.storeConfig.findFirst({ where: { uberCustomerId: customerId } });
  if (!store?.uberClientSecret) {
    logError("uber-webhook", "no hay tienda con ese customer_id", { customerId });
    return new Response(null, { status: 401 });
  }

  const valid = await verifyUberSignature(decrypt(store.uberClientSecret), rawBody, signature);
  if (!valid) {
    logError("uber-webhook", "firma inválida — rechazado", { shop: store.shop });
    return new Response(null, { status: 401 });
  }

  logDebug("uber-webhook", "evento recibido", { type: event.event_type, delivery: event.data?.id });

  if (event.event_type !== "delivery.status.changed") {
    return new Response(null, { status: 200 });
  }

  const { id: uberDeliveryId, status, tracking_url } = event.data;

  if (!uberDeliveryId || !VALID_STATUSES.includes(status)) {
    logDebug("uber-webhook", "status desconocido o ID faltante", { status });
    return new Response(null, { status: 200 });
  }

  const delivery = await db.delivery.findFirst({ where: { uberDeliveryId } });
  if (!delivery) {
    logDebug("uber-webhook", "delivery no encontrado en DB", { uberDeliveryId });
    return new Response(null, { status: 200 });
  }

  const prevStatus = delivery.status;

  await db.delivery.update({
    where: { id: delivery.id },
    data: {
      status,
      ...(tracking_url ? { uberTrackingUrl: tracking_url } : {}),
    },
  });

  logDebug("uber-webhook", "delivery actualizado", { deliveryId: delivery.id, status });

  // Reflejar el avance en la línea de tiempo del pedido en Shopify.
  // Solo al entrar a un estado nuevo, para no duplicar eventos si Uber reenvía
  // el webhook. Requiere que la orden ya esté fulfilled.
  const fulfillmentStatus = FULFILLMENT_EVENT_BY_STATUS[status];
  if (fulfillmentStatus && status !== prevStatus) {
    try {
      const { admin } = await unauthenticated.admin(delivery.shop);
      await addFulfillmentEvent(admin, delivery.orderId, fulfillmentStatus, "uber-webhook/fulfillment-event");
    } catch (err) {
      logError("uber-webhook/fulfillment-event", err, { deliveryId: delivery.id, status });
    }
  }

  return new Response(null, { status: 200 });
};
