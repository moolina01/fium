import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR — customers/redact
 * Shopify lo dispara cuando un cliente pide que se borren sus datos personales.
 * Anonimizamos los Delivery de las órdenes indicadas (no los borramos para no
 * perder el historial de conteo/facturación, pero sí los datos personales).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const ordersToRedact: number[] = (payload as any)?.orders_to_redact ?? [];
  const orderGids = ordersToRedact.map((id) => `gid://shopify/Order/${id}`);

  if (orderGids.length > 0) {
    const result = await db.delivery.updateMany({
      where: { shop, orderId: { in: orderGids } },
      data: {
        customerName: "[redacted]",
        customerAddress: "[redacted]",
        customerComuna: "[redacted]",
      },
    });
    console.log(`[gdpr/redact] shop=${shop} deliveries anonimizados=${result.count}`);
  } else {
    console.log(`[gdpr/redact] shop=${shop} sin órdenes que anonimizar`);
  }

  return new Response(null, { status: 200 });
};
