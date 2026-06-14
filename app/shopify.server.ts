import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { listUberWebhooks, deleteUberWebhook, registerUberWebhook } from "./services/uber-direct.server";
import { logError } from "./lib/logger.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      console.log("[afterAuth] disparado para shop:", session.shop);
      await Promise.all([
        registerCarrierService(session.shop, session.accessToken!),
        ensureUberWebhook(),
      ]);
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export async function ensureUberWebhook(): Promise<void> {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) return;
  try {
    const callbackUrl = `${appUrl}/webhooks/uber/delivery`;
    const existing = await listUberWebhooks();
    for (const wh of existing) {
      if (wh.url !== callbackUrl) await deleteUberWebhook(wh.id);
    }
    if (!existing.some((w) => w.url === callbackUrl)) {
      await registerUberWebhook(callbackUrl);
      console.log("[uber-webhook] registrado:", callbackUrl);
    } else {
      console.log("[uber-webhook] ya existe:", callbackUrl);
    }
  } catch (e) {
    logError("shopify/ensure-uber-webhook", e);
  }
}

export async function registerCarrierService(shop: string, accessToken: string) {
  const appUrl = process.env.SHOPIFY_APP_URL!;
  const callbackUrl = `${appUrl}/carrier/rates`;
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };
  const base = `https://${shop}/admin/api/${ApiVersion.October25}/carrier_services.json`;

  // Listar todos los carrier services existentes
  const listRes = await fetch(base, { headers });
  if (listRes.ok) {
    const { carrier_services } = await listRes.json() as { carrier_services: Array<{ id: number; name: string; callback_url: string }> };

    // Si ya existe con la URL correcta, no hacer nada
    const exact = carrier_services.find((cs) => cs.callback_url === callbackUrl);
    if (exact) {
      console.log("[carrier] ya registrado correctamente:", callbackUrl);
      return { ok: true, alreadyExists: true };
    }

    // Borrar cualquier registro anterior de Fium/Uber Direct con URL vieja
    for (const cs of carrier_services) {
      if (cs.name === "Fium" || cs.name === "Uber Direct") {
        console.log("[carrier] borrando registro viejo:", cs.id, cs.callback_url);
        await fetch(`https://${shop}/admin/api/${ApiVersion.October25}/carrier_services/${cs.id}.json`, {
          method: "DELETE",
          headers,
        });
      }
    }
  }

  // Registrar con la URL actual
  const createRes = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      carrier_service: { name: "Fium", callback_url: callbackUrl, service_discovery: true },
    }),
  });

  const body = await createRes.json();
  console.log("[carrier] registro resultado:", createRes.status, JSON.stringify(body));
  return { ok: createRes.ok, alreadyExists: false, body };
}

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
