import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { listUberWebhooks, deleteUberWebhook, registerUberWebhook, getStoreUberCreds } from "./services/uber-direct.server";
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
      // El webhook de Uber se registra por tienda cuando conecta su cuenta
      // (al guardar credenciales en Settings), no aquí — aquí aún no las tiene.
      await registerCarrierService(session.shop, session.accessToken!);
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

/**
 * Registra el webhook de Uber Direct en la cuenta de UNA tienda. Se llama cuando
 * la tienda conecta/actualiza sus credenciales en Settings. El callback es el
 * mismo para todas las tiendas; cada evento se identifica por su customer_id.
 */
export async function ensureUberWebhookForShop(shop: string): Promise<void> {
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl) return;
  try {
    const creds = await getStoreUberCreds(shop);
    const callbackUrl = `${appUrl}/webhooks/uber/delivery`;
    const existing = await listUberWebhooks(creds);
    for (const wh of existing) {
      if (wh.url !== callbackUrl) await deleteUberWebhook(creds, wh.id);
    }
    if (!existing.some((w) => w.url === callbackUrl)) {
      await registerUberWebhook(creds, callbackUrl);
      console.log("[uber-webhook] registrado para", shop, callbackUrl);
    } else {
      console.log("[uber-webhook] ya existe para", shop);
    }
  } catch (e) {
    logError("shopify/ensure-uber-webhook", e, { shop });
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
