import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { getDeliveryQuote, UberApiError } from "../services/uber-direct.server";
import type { QuoteResult } from "../services/uber-direct.server";
import { checkPlanLimit } from "../lib/plan-limits.server";
import { logError, logInfo, logDebug } from "../lib/logger.server";

// Cache en memoria: clave = "shop|zip_destino|address1_destino", TTL = 5 min
// Evita llamar a Uber cada vez que el cliente cambia algo menor en el checkout
type CacheEntry = { quote: QuoteResult; expiresAt: number };
const quoteCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCached(key: string): QuoteResult | null {
  const entry = quoteCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { quoteCache.delete(key); return null; }
  return entry.quote;
}

function setCached(key: string, quote: QuoteResult) {
  quoteCache.set(key, { quote, expiresAt: Date.now() + CACHE_TTL });
}

/**
 * Verifica la firma HMAC-SHA256 que Shopify adjunta a los callbacks de CarrierService.
 * El header X-Shopify-Hmac-Sha256 es base64(HMAC-SHA256(api_secret, raw_body)).
 */
async function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): Promise<boolean> {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !hmacHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // Comparación de longitud constante para evitar timing attacks
  if (expected.length !== hmacHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  return diff === 0;
}

// Shopify llama este endpoint durante el checkout para obtener tarifas en tiempo real.
// Si Uber Direct no puede cotizar la dirección, devuelve rates:[] y la opción no aparece.

export const action = async ({ request }: ActionFunctionArgs) => {
  logDebug("carrier/rates", "request recibido", { method: request.method });

  if (request.method !== "POST") return new Response(null, { status: 405 });

  const rawBody = await request.text();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
  const valid = await verifyShopifyHmac(rawBody, hmac);
  if (!valid) {
    logError("carrier/rates", "firma HMAC inválida — rechazado");
    return new Response(null, { status: 401 });
  }

  const shop = request.headers.get("X-Shopify-Shop-Domain");
  if (!shop) return Response.json({ rates: [] });

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ rates: [] });
  }

  const dest = body?.rate?.destination;
  if (!dest) return Response.json({ rates: [] });

  // Cotizar SOLO con dirección completa (calle + comuna + código postal).
  // Shopify llama al carrier en cada paso del checkout, y al principio manda
  // datos parciales (solo país/región). Si devolvemos una tarifa ahí, su precio
  // cambia al completar la dirección y Shopify muestra "Las opciones de envío
  // han cambiado". Sin dirección completa, no ofrecemos Fium todavía.
  const address1 = (dest.address1 ?? "").trim();
  const city = (dest.city ?? "").trim();
  const postalCode = (dest.postal_code ?? "").trim();
  // En Chile el código postal casi nunca se llena, y Uber geocodifica bien con
  // calle + comuna + región. Por eso NO exigimos código postal: solo calle y comuna.
  // (Antes se exigía postalCode y por eso Fium no cotizaba si el cliente lo dejaba vacío.)
  if (!address1 || !city) {
    logDebug("carrier/rates", "dirección incompleta — falta calle o comuna", {
      hasAddress1: !!address1, hasCity: !!city, hasPostal: !!postalCode,
    });
    return Response.json({ rates: [] });
  }

  const storeConfig = await db.storeConfig.findUnique({ where: { shop } });
  if (!storeConfig) return Response.json({ rates: [] });

  // Señal de activación: si Shopify nos pide tarifas, el carrier está realmente
  // conectado al checkout (agregado a la zona de envío). Guardamos la última vez,
  // con throttle de 10 min para no escribir en cada llamada del checkout.
  const lastPing = storeConfig.lastRateRequestAt?.getTime() ?? 0;
  if (Date.now() - lastPing > 10 * 60 * 1000) {
    try {
      await db.storeConfig.update({ where: { shop }, data: { lastRateRequestAt: new Date() } });
    } catch (e) {
      logError("carrier/rates/ping", e, { shop });
    }
  }

  // No mostrar cotización si se alcanzó el límite del plan
  const { allowed } = await checkPlanLimit(shop);
  if (!allowed) {
    logInfo("carrier/rates", "límite de plan alcanzado — sin tarifa", { shop });
    return Response.json({ rates: [] });
  }

  const cacheKey = `${shop}|${postalCode}|${address1}|${city}`;
  const cached = getCached(cacheKey);

  try {
    // Usar cache si existe — respuesta inmediata
    const quotePromise = cached
      ? Promise.resolve(cached)
      : getDeliveryQuote({
      pickupAddress: {
        streetAddress: [storeConfig.address],
        city: storeConfig.comuna,
        state: storeConfig.region,
        zipCode: storeConfig.zipCode,
      },
      dropoffAddress: {
        streetAddress: [address1],
        city,
        state: dest.province ?? city,
        zipCode: postalCode,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 8000)
    );

    const quote = await Promise.race([quotePromise, timeoutPromise]);
    logDebug("carrier/rates", "quote OK", { fee: quote.fee, duration: quote.duration });

    if (!cached) setCached(cacheKey, quote);

    const minEta = new Date(Date.now() + quote.duration * 60000).toISOString();
    const maxEta = new Date(Date.now() + (quote.duration + 30) * 60000).toISOString();

    return Response.json({
      rates: [
        {
          service_name: "Fium — Entrega mismo día",
          service_code: "uber_direct",
          total_price: String(quote.fee), // CLP — sin centavos
          currency: "CLP",
          min_delivery_date: quote.dropoffEta || minEta,
          max_delivery_date: quote.dropoffEta || maxEta,
        },
      ],
    });
  } catch (e) {
    // Cuando Uber NO puede cotizar (fuera de cobertura, distancia excedida, sin
    // couriers o dirección no entregable) lanza un UberApiError. Es un caso de
    // negocio esperado, no un bug: lo dejamos VISIBLE y claro en los logs de prod
    // para poder diagnosticar por qué Fium no apareció en un checkout.
    if (e instanceof UberApiError) {
      logInfo("carrier/rates/sin-cobertura", "Uber no entregó cotización (probable fuera de cobertura o distancia excedida)", {
        shop,
        uberStatus: e.status,           // ej. 400 / 422
        uberCode: e.code ?? null,       // ej. "address_undeliverable", "no_couriers_available"
        destino: `${address1}, ${city}`,
        origen: `${storeConfig.address}, ${storeConfig.comuna}`,
        detalleUber: e.body?.slice(0, 300),
      });
    } else {
      logError("carrier/rates", e, { shop });
    }
    return Response.json({ rates: [] });
  }
};
