import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { cancelOrderFulfillments } from "./fulfillment.server";
import { logError, logInfo } from "./logger.server";

export const UBER_CANCELED_REASON =
  "Uber Direct canceló el envío (normalmente porque no encontró un courier disponible). Vuelve a despacharlo.";

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
