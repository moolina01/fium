import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type SubscriptionPayload = {
  app_subscription: {
    admin_graphql_api_id: string;
    name: string;
    status: string; // "ACTIVE" | "CANCELLED" | "DECLINED" | "EXPIRED" | "FROZEN" | "PENDING"
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const { app_subscription } = payload as SubscriptionPayload;
  const { admin_graphql_api_id: subscriptionId, status } = app_subscription;

  console.log(`[subscription-webhook] shop=${shop} id=${subscriptionId} status=${status}`);

  const config = await db.storeConfig.findUnique({ where: { shop } });
  if (!config || config.subscriptionId !== subscriptionId) {
    return new Response("OK", { status: 200 });
  }

  if (status === "ACTIVE") {
    await db.storeConfig.update({
      where: { shop },
      data: { planStatus: "active" },
    });
  } else {
    // CANCELLED, DECLINED, EXPIRED, FROZEN → revocar acceso
    await db.storeConfig.update({
      where: { shop },
      data: { planStatus: "cancelled", plan: "none", subscriptionId: null },
    });
    console.log(`[subscription-webhook] plan revocado para ${shop}`);
  }

  return new Response("OK", { status: 200 });
};
