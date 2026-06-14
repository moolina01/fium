import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await Promise.all([
    // Sesiones siempre se borran (requerimiento de seguridad de Shopify)
    session ? db.session.deleteMany({ where: { shop } }) : Promise.resolve(),

    // Resetear plan — la suscripción ya no existe al desinstalar.
    // planStatus !== "active" bloquea todo acceso hasta que se re-suscriban.
    // Mantenemos dirección y config para que reinstalar sea más fácil.
    // Deliveries se mantienen como historial.
    db.storeConfig.updateMany({
      where: { shop },
      data: {
        plan: "none",
        planStatus: "pending",
        subscriptionId: null,
      },
    }),
  ]);

  console.log(`[uninstall] plan reseteado para ${shop}`);
  return new Response();
};
