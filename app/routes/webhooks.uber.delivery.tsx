import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { getDelivery, uberCredsFromConfig } from "../services/uber-direct.server";
import { logError, logDebug, logInfo } from "../lib/logger.server";
import { applyUberStatus } from "../lib/delivery-status.server";

// Webhook "Delivery Status" de Uber Direct (kind: "event.delivery_status").
// Cada tienda lo crea en su dashboard de Uber (direct.uber.com → Desarrollador →
// Webhooks, evento event.delivery_status) apuntando a esta URL; Uber no permite registrarlo por API.
//
// El aviso se usa solo como DISPARADOR: el estado se lee de la API de Uber con
// las credenciales de la tienda. Así no hace falta la "Webhook Signing Key" de
// cada tienda, y un aviso falso no puede cambiar nada (solo provoca una consulta).
type UberStatusEvent = {
  kind?: string;
  customer_id?: string;
  delivery_id?: string;
  status?: string;
  data?: { id?: string };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  let event: UberStatusEvent;
  try {
    event = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 400 });
  }

  logDebug("uber-webhook", "evento recibido", { kind: event.kind, delivery: event.delivery_id, status: event.status });

  // Otros tipos (ej. event.courier_update, cada pocos segundos) no cambian el estado.
  if (event.kind !== "event.delivery_status") return new Response(null, { status: 200 });

  const uberDeliveryId = event.delivery_id ?? event.data?.id;
  if (!uberDeliveryId || !event.customer_id) return new Response(null, { status: 200 });

  const delivery = await db.delivery.findFirst({ where: { uberDeliveryId } });
  if (!delivery) {
    logDebug("uber-webhook", "delivery no encontrado en DB", { uberDeliveryId });
    return new Response(null, { status: 200 });
  }

  // El delivery debe pertenecer a la tienda dueña de esa cuenta de Uber.
  const store = await db.storeConfig.findUnique({ where: { shop: delivery.shop } });
  if (!store || store.uberCustomerId !== event.customer_id) {
    logError("uber-webhook", "customer_id no coincide con la tienda del envío — ignorado", {
      uberDeliveryId, customerId: event.customer_id,
    });
    return new Response(null, { status: 200 });
  }

  try {
    await db.storeConfig.update({ where: { shop: store.shop }, data: { lastUberWebhookAt: new Date() } });

    const live = await getDelivery(uberCredsFromConfig(store), uberDeliveryId);
    const status = await applyUberStatus(delivery, live, "uber-webhook");
    logInfo("uber-webhook", "estado aplicado", { shop: store.shop, orderNumber: delivery.orderNumber, status });
  } catch (err) {
    // 500 → Uber reintenta el aviso.
    logError("uber-webhook", err, { uberDeliveryId });
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
};
