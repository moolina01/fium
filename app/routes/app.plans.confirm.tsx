import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") ?? "starter";

  // Verificar el estado real de la suscripción con Shopify
  const res = await admin.graphql(`
    #graphql
    query {
      currentAppInstallation {
        activeSubscriptions {
          id
          status
          name
        }
      }
    }
  `);

  const json = await res.json();
  const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const activeSub = subs.find((s: any) => s.name === `Fium ${plan.charAt(0).toUpperCase() + plan.slice(1)}`);

  if (activeSub) {
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { plan, planStatus: "active", subscriptionId: activeSub.id },
    });
  } else {
    // Merchant rechazó o canceló — volver a planes
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { plan: "none", planStatus: "pending", subscriptionId: null },
    });
    throw redirect("/app/plans");
  }

  throw redirect("/app");
};

export default function PlansConfirm() {
  return null;
}
