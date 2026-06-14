import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR — customers/data_request
 * Shopify lo dispara cuando un cliente pide los datos que la tienda guardó sobre él.
 * Fium solo almacena datos de envío en el modelo Delivery (nombre, dirección, comuna).
 * Logueamos qué órdenes se solicitaron; el merchant entrega los datos al cliente.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const ordersRequested: number[] = (payload as any)?.orders_requested ?? [];
  const orderGids = ordersRequested.map((id) => `gid://shopify/Order/${id}`);

  const deliveries = await db.delivery.findMany({
    where: { shop, orderId: { in: orderGids } },
    select: {
      orderNumber: true,
      customerName: true,
      customerAddress: true,
      customerComuna: true,
      status: true,
      createdAt: true,
    },
  });

  console.log(
    `[gdpr/data_request] shop=${shop} órdenes=${ordersRequested.length} deliveries encontrados=${deliveries.length}`,
    JSON.stringify(deliveries)
  );

  return new Response(null, { status: 200 });
};
