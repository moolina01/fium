import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR — shop/redact
 * Shopify lo dispara 48h después de desinstalar la app. Hay que borrar TODO
 * dato de la tienda: configuración, envíos y sesiones.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);

  const [deliveries, configs, sessions] = await Promise.all([
    db.delivery.deleteMany({ where: { shop } }),
    db.storeConfig.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  console.log(
    `[gdpr/shop_redact] shop=${shop} borrados: deliveries=${deliveries.count} config=${configs.count} sessions=${sessions.count}`
  );

  return new Response(null, { status: 200 });
};
