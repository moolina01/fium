/**
 * uber-direct.ts — Cliente completo para la API de Uber Direct (DaaS)
 *
 * Verificado contra:
 *   - Documentación oficial: https://developer.uber.com/docs/deliveries/overview
 *   - Auth guide: https://developer.uber.com/docs/deliveries/guides/authentication
 *   - Get Started: https://developer.uber.com/docs/deliveries/get-started
 *   - SDK oficial: https://github.com/uber/uber-direct-sdk
 *
 * Credenciales: CADA TIENDA conecta su propia cuenta de Uber Direct. Las
 * credenciales (client_id, client_secret cifrado, customer_id) viven en
 * StoreConfig y todas las funciones reciben `creds: UberCreds`. No hay cuenta
 * global — usa getStoreUberCreds(shop) o uberCredsFromConfig(config) para
 * obtenerlas.
 *
 * Endpoints:
 *   Auth:            POST https://auth.uber.com/oauth/v2/token
 *   Create Quote:    POST /v1/customers/{customer_id}/delivery_quotes
 *   Create Delivery: POST /v1/customers/{customer_id}/deliveries
 *   Get Delivery:    GET  /v1/customers/{customer_id}/deliveries/{delivery_id}
 *   List Deliveries: GET  /v1/customers/{customer_id}/deliveries
 *   Update Delivery: POST /v1/customers/{customer_id}/deliveries/{delivery_id}
 *   Cancel Delivery: POST /v1/customers/{customer_id}/deliveries/{delivery_id}/cancel
 */

import db from "../db.server";
import { decrypt } from "../lib/crypto.server";

// ─── URLs ────────────────────────────────────────────────────────────────────

const UBER_AUTH_URL = "https://auth.uber.com/oauth/v2/token";
const UBER_API_BASE = "https://api.uber.com/v1";

// ─── Credenciales por tienda ──────────────────────────────────────────────────
// Cada tienda conecta su propia cuenta de Uber Direct (con su tarjeta), así que
// todas las llamadas a Uber se hacen con las credenciales de esa tienda — no hay
// una cuenta global. Las credenciales viven cifradas en StoreConfig.

export type UberCreds = {
  clientId: string;
  clientSecret: string;
  customerId: string;
};

/** La tienda no terminó de conectar su cuenta de Uber Direct. */
export class UberNotConfiguredError extends Error {
  constructor(shop?: string) {
    super(
      shop
        ? `La tienda ${shop} no tiene conectada su cuenta de Uber Direct`
        : "La tienda no tiene conectada su cuenta de Uber Direct"
    );
    this.name = "UberNotConfiguredError";
  }
}

/** Extrae y descifra las credenciales de un StoreConfig ya cargado. */
export function uberCredsFromConfig(config: {
  shop?: string;
  uberClientId: string | null;
  uberClientSecret: string | null;
  uberCustomerId: string | null;
}): UberCreds {
  if (!config.uberClientId || !config.uberClientSecret || !config.uberCustomerId) {
    throw new UberNotConfiguredError(config.shop);
  }
  return {
    clientId: config.uberClientId,
    clientSecret: decrypt(config.uberClientSecret),
    customerId: config.uberCustomerId,
  };
}

/** Carga las credenciales de Uber de una tienda desde la DB. */
export async function getStoreUberCreds(shop: string): Promise<UberCreds> {
  const config = await db.storeConfig.findUnique({ where: { shop } });
  if (!config) throw new UberNotConfiguredError(shop);
  return uberCredsFromConfig({ ...config, shop });
}

// ─── Auth ────────────────────────────────────────────────────────────────────
// Tokens duran 30 días (2,592,000 seg). Se cachean en memoria (L1) y en DB (L2),
// con clave = clientId de la tienda. Uber rate-limita la generación de tokens a
// 100 req/hora — por eso persistimos en DB: en serverless/multi-instancia el
// cache en memoria no alcanza.

const cachedTokens = new Map<string, { value: string; expiresAt: number }>();

async function getAccessToken(creds: UberCreds): Promise<string> {
  // L1 — cache en memoria del proceso
  const cached = cachedTokens.get(creds.clientId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  // L2 — token persistido en DB (sobrevive reinicios y otras instancias)
  const stored = await db.uberToken.findUnique({ where: { clientId: creds.clientId } });
  if (stored && Date.now() < stored.expiresAt.getTime() - 300_000) {
    cachedTokens.set(creds.clientId, {
      value: stored.token,
      expiresAt: stored.expiresAt.getTime() - 300_000,
    });
    return stored.token;
  }

  const params = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "client_credentials",
    scope: "eats.deliveries",
  });

  const res = await fetch(UBER_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new UberApiError("Auth failed", res.status, text);
  }

  const data = await res.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);

  // Persistir en DB y cachear en memoria (renovamos 5 min antes de expirar)
  await db.uberToken.upsert({
    where: { clientId: creds.clientId },
    create: { clientId: creds.clientId, token: data.access_token, expiresAt },
    update: { token: data.access_token, expiresAt },
  });
  cachedTokens.set(creds.clientId, {
    value: data.access_token,
    expiresAt: expiresAt.getTime() - 300_000,
  });

  return data.access_token;
}

/** Fuerza renovación del token (útil si recibes un 401 inesperado) */
export async function invalidateToken(creds: UberCreds): Promise<void> {
  cachedTokens.delete(creds.clientId);
  await db.uberToken.deleteMany({ where: { clientId: creds.clientId } });
}

/**
 * Valida que las credenciales sirvan: pide un token a Uber. Lanza UberApiError
 * si el client_id/secret son inválidos. Se usa en "Probar conexión" de Settings.
 */
export async function testUberConnection(creds: UberCreds): Promise<void> {
  // Saltar el cache para validar de verdad contra Uber.
  cachedTokens.delete(creds.clientId);
  await db.uberToken.deleteMany({ where: { clientId: creds.clientId } });
  await getAccessToken(creds);
}

// ─── Error personalizado ────────────────────────────────────────────────────

export class UberApiError extends Error {
  status: number;
  body: string;
  code?: string;
  metadata?: Record<string, string>;

  constructor(message: string, status: number, body: string) {
    super(`${message}: ${status} ${body}`);
    this.name = "UberApiError";
    this.status = status;
    this.body = body;

    // Intentar parsear la respuesta de Uber para extraer code y metadata
    try {
      const parsed = JSON.parse(body);
      this.code = parsed.code;
      this.metadata = parsed.metadata;
    } catch {
      // Body no es JSON — dejarlo como string
    }
  }
}

// ─── Helpers internos ───────────────────────────────────────────────────────

async function uberFetch<T>(
  creds: UberCreds,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = await getAccessToken(creds);
  const url = `${UBER_API_BASE}/customers/${creds.customerId}${path}`;

  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new UberApiError(`Uber API ${options.method ?? "GET"} ${path}`, res.status, text);
  }

  return res.json() as Promise<T>;
}

// ─── Tipos: Dirección ───────────────────────────────────────────────────────
// La API espera las direcciones como un JSON STRING dentro del JSON del body.
// Ejemplo: "pickup_address": "{\"street_address\":[\"Av Providencia 1234\"],\"city\":\"Santiago\",...}"

export type UberAddress = {
  streetAddress: string[];       // Array de líneas, ej: ["Av Providencia 1234", "Depto 502"]
  city: string;
  state: string;
  zipCode: string;
  country?: string;              // Default: "CL"
};

/** Convierte UberAddress a JSON string como espera la API */
function formatAddress(addr: UberAddress): string {
  return JSON.stringify({
    street_address: addr.streetAddress,
    city: addr.city,
    state: addr.state,
    zip_code: addr.zipCode,
    country: addr.country ?? "CL",
  });
}

// ─── Tipos: Coordenadas ────────────────────────────────────────────────────
// Importantes en Chile y Latam — la geocodificación por texto puede fallar.

export type LatLng = {
  latitude: number;
  longitude: number;
};

// ─── QUOTE ──────────────────────────────────────────────────────────────────
// POST /v1/customers/{customer_id}/delivery_quotes
//
// Evalúa si un envío es posible entre dos puntos y devuelve costo + tiempo.
// El quote_id resultante es obligatorio para crear el delivery.
// El quote expira en ~15 minutos.

export type QuoteRequest = {
  pickupAddress: UberAddress;
  dropoffAddress: UberAddress;
  pickupLatLng?: LatLng;         // Recomendado en Chile
  dropoffLatLng?: LatLng;        // Recomendado en Chile
};

export type QuoteResult = {
  id: string;                     // "dqt_ABC123..." — usar como quote_id
  fee: number;                    // En la menor unidad de la moneda (CLP = pesos)
  currency: string;               // "clp"
  currencyType: string;           // "CLP"
  duration: number;               // Minutos totales estimados (pickup → dropoff)
  pickupDuration: number;         // Minutos hasta que el courier llega al pickup
  dropoffEta: string;             // ISO datetime estimada de entrega
  dropoffDeadline: string;        // ISO datetime máxima de entrega
  expires: string;                // ISO datetime — el quote muere después de esto (~15 min)
  created: string;                // ISO datetime de creación
};

export async function getDeliveryQuote(creds: UberCreds, req: QuoteRequest): Promise<QuoteResult> {
  const body: Record<string, unknown> = {
    pickup_address: formatAddress(req.pickupAddress),
    dropoff_address: formatAddress(req.dropoffAddress),
  };

  // Coordenadas — recomendadas para Chile
  if (req.pickupLatLng) {
    body.pickup_latitude = req.pickupLatLng.latitude;
    body.pickup_longitude = req.pickupLatLng.longitude;
  }
  if (req.dropoffLatLng) {
    body.dropoff_latitude = req.dropoffLatLng.latitude;
    body.dropoff_longitude = req.dropoffLatLng.longitude;
  }

  const data = await uberFetch<Record<string, unknown>>(creds, "/delivery_quotes", {
    method: "POST",
    body,
  });

  return {
    id: data.id as string,
    fee: data.fee as number,
    currency: data.currency as string,
    currencyType: (data.currency_type as string) ?? "",
    duration: data.duration as number,
    pickupDuration: (data.pickup_duration as number) ?? 0,
    dropoffEta: (data.dropoff_eta as string) ?? "",
    dropoffDeadline: (data.dropoff_deadline as string) ?? "",
    expires: (data.expires as string) ?? "",
    created: (data.created as string) ?? "",
  };
}

// ─── CREATE DELIVERY ────────────────────────────────────────────────────────
// POST /v1/customers/{customer_id}/deliveries
//
// Crea el envío real. Un courier de Uber es despachado al pickup.
// Requiere el quote_id del paso anterior.

export type ManifestItem = {
  name: string;
  quantity: number;
  size?: "small" | "medium" | "large" | "xlarge";
  weight?: number;                // Gramos
  price?: number;                 // En la menor unidad de la moneda
  dimensions?: {
    length: number;               // Centímetros
    height: number;
    depth: number;
  };
  mustBeUpright?: boolean;
};

export type CreateDeliveryRequest = {
  quoteId: string;
  // Pickup (tienda)
  pickupName: string;
  pickupAddress: UberAddress;
  pickupPhone: string;            // Formato E.164: "+56911111111"
  pickupLatLng?: LatLng;
  pickupNotes?: string;           // Instrucciones para el courier en el pickup
  // Dropoff (cliente)
  dropoffName: string;
  dropoffAddress: UberAddress;
  dropoffPhone: string;
  dropoffLatLng?: LatLng;
  dropoffNotes?: string;          // Instrucciones para el courier en el dropoff
  // Paquete
  manifestItems: ManifestItem[];
  manifestTotalValue?: number;    // Valor total del pedido
  // Tracking
  externalId?: string;            // Tu ID interno (ej: el order ID de Shopify)
  // Testing
  testMode?: boolean;             // Activa roboCourier en sandbox
};

export type DeliveryResult = {
  id: string;                     // "del_XYZ789..."
  status: string;                 // "pending" | "pickup" | "pickup_complete" | "dropoff" | "delivered" | "canceled" | "returned"
  fee: number;
  currency: string;
  trackingUrl: string;            // URL para que el cliente final rastree el envío
  pickupEta: string | null;
  dropoffEta: string | null;
  liveMode: boolean;
  courier: {
    name: string;
    phone: string;
    vehicleType: string;
    imgHref: string;
    location: LatLng | null;
  } | null;
};

export async function createDelivery(
  creds: UberCreds,
  req: CreateDeliveryRequest
): Promise<DeliveryResult> {
  const body: Record<string, unknown> = {
    quote_id: req.quoteId,
    // Pickup
    pickup_name: req.pickupName,
    pickup_address: formatAddress(req.pickupAddress),
    pickup_phone_number: req.pickupPhone,
    // Dropoff
    dropoff_name: req.dropoffName,
    dropoff_address: formatAddress(req.dropoffAddress),
    dropoff_phone_number: req.dropoffPhone,
    // Manifest
    manifest_items: req.manifestItems.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      size: item.size ?? "small",
      ...(item.weight != null && { weight: item.weight }),
      ...(item.price != null && { price: item.price }),
      ...(item.dimensions && { dimensions: item.dimensions }),
      ...(item.mustBeUpright != null && { must_be_upright: item.mustBeUpright }),
    })),
  };

  // Coordenadas opcionales
  if (req.pickupLatLng) {
    body.pickup_latitude = req.pickupLatLng.latitude;
    body.pickup_longitude = req.pickupLatLng.longitude;
  }
  if (req.dropoffLatLng) {
    body.dropoff_latitude = req.dropoffLatLng.latitude;
    body.dropoff_longitude = req.dropoffLatLng.longitude;
  }

  // Opcionales
  if (req.pickupNotes) body.pickup_notes = req.pickupNotes;
  if (req.dropoffNotes) body.dropoff_notes = req.dropoffNotes;
  if (req.externalId) body.external_id = req.externalId;
  if (req.manifestTotalValue != null) body.manifest_total_value = req.manifestTotalValue;

  // Sandbox: simula un courier automático para testing
  if (req.testMode) {
    body.test_specifications = {
      robo_courier_specification: { mode: "auto" },
    };
  }

  const data = await uberFetch<Record<string, unknown>>(creds, "/deliveries", {
    method: "POST",
    body,
  });

  return mapDeliveryResponse(data);
}

// ─── GET DELIVERY ───────────────────────────────────────────────────────────
// GET /v1/customers/{customer_id}/deliveries/{delivery_id}

export async function getDelivery(creds: UberCreds, deliveryId: string): Promise<DeliveryResult> {
  const data = await uberFetch<Record<string, unknown>>(
    creds,
    `/deliveries/${deliveryId}`
  );
  return mapDeliveryResponse(data);
}

// ─── LIST DELIVERIES ────────────────────────────────────────────────────────
// GET /v1/customers/{customer_id}/deliveries

export async function listDeliveries(creds: UberCreds): Promise<DeliveryResult[]> {
  const data = await uberFetch<Record<string, unknown>[]>(creds, "/deliveries");
  return (data ?? []).map(mapDeliveryResponse);
}

// ─── CANCEL DELIVERY ────────────────────────────────────────────────────────
// POST /v1/customers/{customer_id}/deliveries/{delivery_id}/cancel

export async function cancelDelivery(creds: UberCreds, deliveryId: string): Promise<DeliveryResult> {
  const data = await uberFetch<Record<string, unknown>>(
    creds,
    `/deliveries/${deliveryId}/cancel`,
    { method: "POST", body: {} }
  );
  return mapDeliveryResponse(data);
}

// ─── PROOF OF DELIVERY ───────────────────────────────────────────────────────
// POST /v1/customers/{customer_id}/deliveries/{delivery_id}/proof-of-delivery
//
// Devuelve la prueba de entrega capturada por el courier (foto, firma o PIN)
// como una imagen codificada en base64. type: "picture" | "signature" | "pincode".
// Lanza UberApiError si ese tipo no fue capturado para el delivery.

export type ProofType = "picture" | "signature" | "pincode";

export async function getProofOfDelivery(
  creds: UberCreds,
  deliveryId: string,
  type: ProofType = "picture",
  waypoint: "pickup" | "dropoff" = "dropoff"
): Promise<string | null> {
  const data = await uberFetch<{ document?: string }>(
    creds,
    `/deliveries/${deliveryId}/proof-of-delivery`,
    { method: "POST", body: { waypoint, type } }
  );
  return data.document ?? null;
}

// ─── WEBHOOKS ────────────────────────────────────────────────────────────────
// POST /v1/customers/{customer_id}/webhooks
// Uber envía un POST a la URL registrada con cada cambio de estado.
// El header X-Postmates-Signature contiene HMAC-SHA256(client_secret, raw_body).

export type UberWebhookEvent = {
  event_id: string;
  event_type: string;
  customer_id: string;
  data: {
    id: string;
    status: string;
    tracking_url?: string;
    courier?: Record<string, unknown>;
    pickup_eta?: string;
    dropoff_eta?: string;
  };
  created: string;
};

export async function registerUberWebhook(creds: UberCreds, callbackUrl: string): Promise<void> {
  await uberFetch(creds, "/webhooks", {
    method: "POST",
    body: {
      url: callbackUrl,
      event_types: ["delivery.status.changed"],
    },
  });
}

export async function listUberWebhooks(creds: UberCreds): Promise<{ id: string; url: string }[]> {
  const data = await uberFetch<{ data: { id: string; url: string }[] }>(creds, "/webhooks");
  return data?.data ?? [];
}

export async function deleteUberWebhook(creds: UberCreds, webhookId: string): Promise<void> {
  await uberFetch(creds, `/webhooks/${webhookId}`, { method: "DELETE" });
}

/**
 * Verifica la firma HMAC-SHA256 de Uber con el client_secret de la tienda.
 * Retorna true si es válida. El webhook llega sin identificar la tienda, así que
 * el caller resuelve primero qué tienda es (por customer_id) y pasa su secret.
 */
export async function verifyUberSignature(
  clientSecret: string,
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  if (!clientSecret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}

// ─── Response mapper ────────────────────────────────────────────────────────

function mapDeliveryResponse(data: Record<string, unknown>): DeliveryResult {
  const courier = data.courier as Record<string, unknown> | null;
  const courierLocation = courier?.location as Record<string, number> | null;

  return {
    id: data.id as string,
    status: data.status as string,
    fee: (data.fee as number) ?? 0,
    currency: (data.currency as string) ?? "",
    trackingUrl: (data.tracking_url as string) ?? "",
    pickupEta: (data.pickup_eta as string) ?? null,
    dropoffEta: (data.dropoff_eta as string) ?? null,
    liveMode: (data.live_mode as boolean) ?? false,
    courier: courier
      ? {
          name: (courier.name as string) ?? "",
          phone: (courier.phone_number as string) ?? "",
          vehicleType: (courier.vehicle_type as string) ?? "",
          imgHref: (courier.img_href as string) ?? "",
          location: courierLocation
            ? {
                latitude: courierLocation.lat,
                longitude: courierLocation.lng,
              }
            : null,
        }
      : null,
  };
}