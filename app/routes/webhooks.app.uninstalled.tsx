import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Sesiones siempre se borran (requerimiento de seguridad de Shopify).
  // Mantenemos StoreConfig y deliveries para que reinstalar sea más fácil.
  if (session) await db.session.deleteMany({ where: { shop } });

  return new Response();
};
