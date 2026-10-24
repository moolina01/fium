import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getDeliveryQuote, createDelivery, uberCredsFromConfig } from "../services/uber-direct.server";
import { PACKAGE_SIZES, toPackageSize, sizeFromGrams, formatKg, effectiveSize, CAR_ONLY_SIZE, VEHICLE_LABEL } from "../lib/package-size";
import { normalizeChileanPhone } from "../lib/phone";
import { fulfillOrderWithTracking } from "../lib/fulfillment.server";
import { isUberTestShop } from "../lib/test-shops.server";
import { formatTimeCL } from "../lib/dispatch-hours";
import { TEST_SCENARIOS, UNDELIVERABLE_ACTIONS, isCancelScenario, toTestScenario, toUndeliverableAction, type TestScenario, type UndeliverableAction } from "../lib/test-scenarios";
import { logError } from "../lib/logger.server";
import { buildManifest, parseManifestLines, type ManifestLine } from "../lib/manifest";
import { Bike, Car, Check, ExternalLink } from "lucide-react";
import { colors as F, FONT, DISPLAY_FONT } from "../lib/theme";

type ShopifyOrder = {
  id: string; name: string; note: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  phone: string | null;
  shippingAddress: { name: string; address1: string; city: string; province: string | null; zip: string; phone: string | null } | null;
  billingAddress: { phone: string | null } | null;
  totalWeight: string | number | null;
  lineItems: { edges: Array<{ node: {
    title: string; quantity: number; requiresShipping: boolean;
    originalUnitPriceSet: { shopMoney: { amount: string } };
  } }> };
};

async function fetchOrder(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  orderId: string
): Promise<ShopifyOrder | null> {
  const res = await admin.graphql(`
    #graphql
    query GetOrder($id: ID!) {
      order(id: $id) {
        id name phone note
        totalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { name address1 city province zip phone }
        billingAddress { phone }
        totalWeight
        lineItems(first: 50) { edges { node { title quantity requiresShipping originalUnitPriceSet { shopMoney { amount } } } } }
      }
    }
  `, { variables: { id: `gid://shopify/Order/${orderId}` } });
  const json = await res.json();
  return json.data?.order ?? null;
}

/**
 * Peso total en gramos del pedido. LineItem.weight no existe desde la API
 * 2026-01, y leerlo desde la variante exigiría el scope read_products, así que
 * se usa Order.totalWeight (gramos), que Shopify ya calcula.
 */
function orderWeightGrams(order: ShopifyOrder): number {
  return Number(order.totalWeight ?? 0);
}

/**
 * Productos del pedido con peso y precio por unidad, para el manifest de Uber.
 * El peso por producto viene del webhook orders/paid (guardado en OrderManifest).
 * Si no está (pedido anterior a ese registro), se reparte el peso total del
 * pedido en partes iguales por unidad: el total que ve Uber sigue siendo el real.
 */
async function orderManifestLines(shop: string, order: ShopifyOrder): Promise<ManifestLine[]> {
  const saved = await db.orderManifest.findUnique({ where: { shop_orderId: { shop, orderId: order.id } } });
  const savedLines = parseManifestLines(saved?.items);
  if (savedLines) return savedLines;

  const nodes = order.lineItems.edges.map((e) => e.node).filter((n) => n.requiresShipping !== false);
  const units = nodes.reduce((sum, n) => sum + n.quantity, 0);
  const gramsPerUnit = units > 0 ? orderWeightGrams(order) / units : 0;
  return nodes.map((n) => ({
    title: n.title,
    quantity: n.quantity,
    grams: gramsPerUnit,
    unitPrice: Number(n.originalUnitPriceSet.shopMoney.amount) || 0,
  }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const orderId = params.id!;

  const shopifyOrderId = `gid://shopify/Order/${orderId}`;
  const [order, storeConfig, existingDelivery] = await Promise.all([
    fetchOrder(admin, orderId),
    db.storeConfig.findUnique({ where: { shop: session.shop } }),
    db.delivery.findFirst({
      where: { orderId: shopifyOrderId, shop: session.shop, status: { not: "failed" } },
    }),
  ]);

  if (!order) throw new Response("Orden no encontrada", { status: 404 });
  if (!storeConfig) throw redirect("/app/settings");
  if (existingDelivery) throw redirect("/app");

  let quote = null;
  let quoteError: string | null = null;

  if (order.shippingAddress) {
    try {
      const creds = uberCredsFromConfig(storeConfig);
      quote = await getDeliveryQuote(creds, {
        pickupAddress: { streetAddress: [storeConfig.address], city: storeConfig.comuna, state: storeConfig.region, zipCode: storeConfig.zipCode },
        dropoffAddress: { streetAddress: [order.shippingAddress.address1], city: order.shippingAddress.city, state: order.shippingAddress.province ?? order.shippingAddress.city, zipCode: order.shippingAddress.zip },
      });
    } catch (e) {
      quoteError = e instanceof Error ? e.message : "Error al obtener cotización";
    }
  }

  const formattedTotal = `$${Number(order.totalPriceSet.shopMoney.amount).toFixed(0)} ${order.totalPriceSet.shopMoney.currencyCode}`;

  // Resolver teléfono del cliente buscando en los campos accesibles con
  // read_orders: dirección de envío > teléfono de la orden > facturación.
  const customerPhone =
    normalizeChileanPhone(order.shippingAddress?.phone) ||
    normalizeChileanPhone(order.phone) ||
    normalizeChileanPhone(order.billingAddress?.phone) ||
    null;

  const missingPhone = !customerPhone;
  // Teléfono de la tienda — respaldo cuando la orden no trae el del cliente
  // (Uber no puede ejecutar el envío sin teléfono).
  const storePhone = storeConfig.phone;

  // Link al pedido completo en el admin de Shopify (ahí están las fotos y el
  // desglose de lo que pagó el cliente). Usa el dominio .myshopify.com → siempre válido.
  const adminOrderUrl = `https://${session.shop}/admin/orders/${orderId}`;

  // Peso total del pedido (gramos) → tamaño sugerido para Uber.
  const totalGrams = orderWeightGrams(order);
  const suggestedSize = sizeFromGrams(totalGrams);

  // Tienda en modo prueba → se muestra el simulador de escenarios del robo-courier.
  const testShop = isUberTestShop(session.shop);

  return { order, storeConfig, quote, quoteError, orderId, formattedTotal, customerPhone, missingPhone, storePhone, adminOrderUrl, totalGrams, suggestedSize, testShop };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const orderId = params.id!;

  const [order, storeConfig] = await Promise.all([
    fetchOrder(admin, orderId),
    db.storeConfig.findUnique({ where: { shop: session.shop } }),
  ]);

  if (!order || !storeConfig || !order.shippingAddress) {
    return { error: "No se pudo procesar la orden." };
  }

  let creds;
  try {
    creds = uberCredsFromConfig(storeConfig);
  } catch {
    return { error: "Conecta tu cuenta de Uber Direct en Configuración antes de despachar." };
  }

  const formData = await request.formData();
  const quoteId = formData.get("quoteId") as string;
  // Precio que la tienda vio en pantalla (en la unidad de Uber, ×100). Nunca se
  // crea un envío más caro que esto sin que la tienda lo vuelva a confirmar.
  const quotedFee = Number(formData.get("quotedFee")) || 0;
  if (!quoteId || !quotedFee) {
    return { error: "No hay una cotización vigente de Uber. Recarga la página para cotizar de nuevo." };
  }
  const manualPhone = formData.get("manualPhone") as string;
  const dropoffNotes = ((formData.get("dropoffNotes") as string) || "").trim() || undefined;
  const pickupNotes = storeConfig.pickupNotes || undefined;
  const packageSize = effectiveSize(
    toPackageSize(formData.get("packageSize") || sizeFromGrams(orderWeightGrams(order)) || storeConfig.packageSize),
    storeConfig.carOnly
  );
  // Último respaldo: el teléfono de la tienda, para que aunque el merchant
  // borre el campo manual, Uber igual reciba un teléfono y pueda despachar.
  const dropoffPhone =
    normalizeChileanPhone(order.shippingAddress.phone) ||
    normalizeChileanPhone(order.phone) ||
    normalizeChileanPhone(order.billingAddress?.phone) ||
    normalizeChileanPhone(manualPhone) ||
    normalizeChileanPhone(storeConfig.phone) ||
    "";

  const pickupAddress = { streetAddress: [storeConfig.address], city: storeConfig.comuna, state: storeConfig.region, zipCode: storeConfig.zipCode };
  const dropoffAddress = { streetAddress: [order.shippingAddress.address1], city: order.shippingAddress.city, state: order.shippingAddress.province ?? order.shippingAddress.city, zipCode: order.shippingAddress.zip };
  const manifest = buildManifest(await orderManifestLines(session.shop, order), packageSize);
  const manifestItems = manifest.items;
  const manifestTotalValue = manifest.totalValue;
  const externalId = order.name;
  // Robo-courier de Uber (sandbox) SOLO para la tienda de review de Shopify.
  const testMode = isUberTestShop(session.shop);
  // Simulador: escenario y qué hacer si no se puede entregar. Solo en modo prueba;
  // en tiendas reales no se manda nada y Uber usa su comportamiento por defecto.
  const testScenario = testMode ? toTestScenario(formData.get("testScenario")) : undefined;
  const undeliverableAction = testMode ? toUndeliverableAction(formData.get("undeliverableAction")) : undefined;
  // Uber exige E.164; tiendas antiguas pueden tener el teléfono guardado sin formato.
  const pickupPhone = normalizeChileanPhone(storeConfig.phone) || storeConfig.phone;

  let activeQuoteId = quoteId;
  let delivery;
  try {
    delivery = await createDelivery(creds, {
      quoteId: activeQuoteId,
      pickupName: storeConfig.contactName, pickupAddress, pickupPhone, pickupNotes,
      dropoffName: order.shippingAddress.name, dropoffAddress, dropoffPhone, dropoffNotes, manifestItems, manifestTotalValue, externalId, testMode, testScenario, undeliverableAction,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // Si el quote expiró, obtener uno nuevo y reintentar una vez
    if (msg.toLowerCase().includes("expired") || msg.includes("quote") || msg.includes("422") || msg.includes("invalid")) {
      try {
        const freshQuote = await getDeliveryQuote(creds, { pickupAddress, dropoffAddress });
        if (freshQuote.fee > quotedFee) {
          // La cotización venció y Uber ahora cobra más: no se crea el envío;
          // se muestra el precio nuevo para que la tienda decida.
          return {
            priceChanged: {
              previousFee: quotedFee,
              quote: {
                id: freshQuote.id, fee: freshQuote.fee, currency: freshQuote.currency,
                duration: freshQuote.duration, expires: freshQuote.expires,
              },
            },
          };
        }
        delivery = await createDelivery(creds, {
          quoteId: freshQuote.id,
          pickupName: storeConfig.contactName, pickupAddress, pickupPhone, pickupNotes,
          dropoffName: order.shippingAddress.name, dropoffAddress, dropoffPhone, dropoffNotes, manifestItems, manifestTotalValue, externalId, testMode, testScenario, undeliverableAction,
        });
      } catch (e2) {
        return { error: e2 instanceof Error ? e2.message : "Error al crear el envío en Uber Direct." };
      }
    } else {
      return { error: msg || "Error al crear el envío en Uber Direct." };
    }
  }

  if (delivery.fee > quotedFee) {
    // No debería pasar: Uber respeta el precio de una cotización vigente.
    logError("orders/manual-dispatch", "Uber cobró más que la cotización mostrada", {
      shop: session.shop, orderNumber: order.name, quotedFee, fee: delivery.fee,
    });
  }

  // Borrar cualquier registro fallido previo del auto-despacho
  await db.delivery.deleteMany({ where: { orderId: order.id, shop: session.shop, status: "failed" } });

  const created = await db.delivery.create({
    data: {
      shop: session.shop,
      orderId: order.id,
      orderNumber: order.name,
      customerName: order.shippingAddress.name,
      customerAddress: order.shippingAddress.address1,
      customerComuna: order.shippingAddress.city,
      uberDeliveryId: delivery.id,
      uberTrackingUrl: delivery.trackingUrl,
      status: delivery.status,
      quoteAmount: delivery.fee ? delivery.fee / 100 : null,
    },
  });

  // Marcar fulfilled en Shopify con el tracking de Uber — saca la orden de
  // "Por gestionar" y avisa al cliente. No bloquea el flujo si falla.
  await fulfillOrderWithTracking(admin, order.id, delivery.trackingUrl, "orders/manual-fulfill");

  // El dashboard usa ?despachado=<id> para animar el paso a "En curso" y resaltar el envío.
  throw redirect(`/app?despachado=${created.id}`);
};

/** Monto de Uber (×100) → "$2.953". */
function formatClp(uberAmount: number): string {
  return `$${Math.round(uberAmount / 100).toLocaleString("es-CL")}`;
}

export default function OrderDetail() {
  const { order, storeConfig, quote: initialQuote, quoteError, formattedTotal, customerPhone, storePhone, adminOrderUrl, totalGrams, suggestedSize, testShop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  // Si al confirmar la cotización había vencido y Uber subió el precio, se
  // muestra la cotización nueva y hay que volver a confirmar.
  const priceChanged = actionData && "priceChanged" in actionData ? actionData.priceChanged : null;
  const quote = priceChanged?.quote ?? initialQuote;
  const formattedFee = quote ? formatClp(quote.fee) : null;
  const navigation = useNavigation();
  const confirming = navigation.state === "submitting";
  const font = { fontFamily: FONT };
  // Modal de confirmación antes de despachar (evita envíos accidentales).
  const [showConfirm, setShowConfirm] = useState(false);
  useEffect(() => { if (actionData) setShowConfirm(false); }, [actionData]);
  // Si la orden no trae teléfono del cliente, pre-llenamos con el de la tienda
  // (Uber lo necesita sí o sí). El merchant puede cambiarlo antes de despachar.
  const [manualPhone, setManualPhone] = useState(customerPhone ? "" : (storePhone ?? ""));
  // Pre-seleccionado según el peso del pedido; el merchant puede cambiarlo.
  // Con "Siempre auto" queda fijo en Extra grande (el único que asegura auto).
  const carOnly = storeConfig.carOnly;
  const [packageSize, setPackageSize] = useState<string>(
    carOnly ? CAR_ONLY_SIZE : suggestedSize ?? storeConfig.packageSize ?? "medium"
  );
  // Simulador de pruebas (solo tiendas en modo prueba).
  const [testScenario, setTestScenario] = useState<TestScenario>("fast");
  const [undeliverableAction, setUndeliverableAction] = useState<UndeliverableAction>("return");
  const effectivePhone = customerPhone || manualPhone;
  const canSubmit = !!effectivePhone && !!quote;

  return (
    <s-page heading={order.name}>
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", ...font }}>

        {priceChanged && (
          <div role="alert" style={{
            background: F.warningTint, border: "1px solid #FDE68A", borderRadius: "10px",
            padding: "13px 16px", color: "#92400E", fontSize: "14px", lineHeight: 1.5,
          }}>
            <strong>El precio de Uber cambió:</strong> la cotización anterior venció y ahora el envío cuesta{" "}
            <strong>{formatClp(priceChanged.quote.fee)}</strong> (antes {formatClp(priceChanged.previousFee)}).
            No se creó el envío. Revisa el nuevo precio y confirma de nuevo si estás de acuerdo.
          </div>
        )}

        {actionData && "error" in actionData && actionData.error && (
          <div style={{
            background: F.dangerTint, border: `1px solid #FECACA`,
            borderRadius: "10px", padding: "13px 16px",
            color: F.danger, fontSize: "14px", display: "flex", gap: "8px",
          }}>
            ⚠️ {"error" in actionData ? actionData.error : null}
          </div>
        )}

        {/* Ruta del envío */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Ruta del envío
            </span>
          </div>
          <div style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "0" }}>
            {/* Pickup */}
            <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "3px" }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: F.brand, flexShrink: 0 }} />
                <div style={{ width: "2px", flex: 1, background: F.border, minHeight: "28px", margin: "4px 0" }} />
              </div>
              <div style={{ paddingBottom: "16px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: F.brand, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "3px" }}>Recogida · tu tienda</div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: F.ink }}>{storeConfig.contactName}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{storeConfig.address}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{storeConfig.comuna}, {storeConfig.region}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{storeConfig.phone}</div>
              </div>
            </div>
            {/* Dropoff */}
            <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
              <div style={{ paddingTop: "3px" }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "2px", background: F.ink, flexShrink: 0 }} />
              </div>
              <div>
                <div style={{ fontSize: "11px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "3px" }}>Entrega · cliente</div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: F.ink }}>{order.shippingAddress?.name ?? "Sin nombre"}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{order.shippingAddress?.address1}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{order.shippingAddress?.city}, {order.shippingAddress?.zip}</div>
                {customerPhone ? (
                  <div style={{ fontSize: "13px", color: F.muted }}>{customerPhone}</div>
                ) : (
                  <div style={{ marginTop: "6px" }}>
                    <div style={{ fontSize: "12px", color: F.warning, fontWeight: "600", marginBottom: "4px" }}>
                      ⚠️ Esta orden no trae teléfono del cliente
                    </div>
                    <div style={{ fontSize: "12px", color: F.muted, marginBottom: "8px", lineHeight: "1.5", maxWidth: "340px" }}>
                      Uber necesita un teléfono para coordinar la entrega. Como no se recibió el del cliente,
                      usamos el <strong>teléfono de tu tienda</strong> por defecto para que el envío se pueda crear.
                      Puedes cambiarlo aquí si tienes otro.
                    </div>
                    <input
                      type="tel"
                      placeholder="+56 9 1234 5678"
                      value={manualPhone}
                      onChange={(e) => setManualPhone(e.target.value)}
                      style={{
                        padding: "7px 10px", border: `1.5px solid ${F.warning}`,
                        borderRadius: "7px", fontSize: "13px", color: F.text,
                        background: F.surface, outline: "none", width: "200px",
                        fontFamily: FONT,
                      }}
                    />
                    <div style={{ fontSize: "11px", color: F.muted, marginTop: "8px", lineHeight: "1.5", maxWidth: "340px" }}>
                      💡 Para que no vuelva a pasar, haz el teléfono <strong>obligatorio</strong> en el checkout:
                      Shopify → Configuración → Pagos/Checkout → Información de contacto → exigir teléfono.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Productos */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Preparar para envío
            </span>
            <a
              href={adminOrderUrl}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: F.brand, fontWeight: 600, textDecoration: "none" }}
            >
              Ver pedido en Shopify <ExternalLink size={12} strokeWidth={2.25} aria-hidden="true" />
            </a>
          </div>

          {/* Lista de empaque: cantidad primero, como una guía de picking */}
          <div style={{ padding: "6px 18px" }}>
            {order.lineItems.edges.map(({ node }, i) => (
              <div
                key={`${node.title}-${i}`}
                style={{
                  display: "flex", alignItems: "center", gap: "12px", padding: "10px 0",
                  borderTop: i === 0 ? "none" : `1px solid ${F.border}`,
                }}
              >
                <span style={{
                  minWidth: "34px", height: "28px", padding: "0 8px", borderRadius: "6px",
                  background: F.brandTint, color: F.brand, fontSize: "13px", fontWeight: 700,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontVariantNumeric: "tabular-nums", flexShrink: 0,
                }}>
                  {node.quantity}×
                </span>
                <span style={{ fontSize: "14px", fontWeight: 500, color: F.text }}>{node.title}</span>
              </div>
            ))}
          </div>

          {/* Resumen: peso y lo que pagó el cliente (NO es el costo del envío) */}
          <div style={{
            display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap",
            padding: "12px 18px", borderTop: `1px solid ${F.border}`, background: F.bg, fontSize: "13px",
          }}>
            <span style={{ color: F.muted }}>
              Peso total{" "}
              <strong style={{ color: F.ink, fontWeight: 600 }}>{totalGrams > 0 ? formatKg(totalGrams) : "sin peso cargado"}</strong>
            </span>
            <span style={{ color: F.muted }}>
              Pagó el cliente <strong style={{ color: F.ink, fontWeight: 600 }}>{formattedTotal}</strong>
            </span>
          </div>

          {/* Tamaño del paquete */}
          <div style={{ padding: "16px 18px", borderTop: `1px solid ${F.border}` }}>
            <div id="package-size-label" style={{ fontSize: "13px", fontWeight: 600, color: F.ink, marginBottom: "10px" }}>
              Tamaño del paquete
            </div>
            <div
              role="radiogroup"
              aria-labelledby="package-size-label"
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "8px" }}
            >
              {PACKAGE_SIZES.map((s) => {
                const selected = packageSize === s.value;
                const suggested = !carOnly && suggestedSize === s.value;
                const locked = carOnly && s.value !== CAR_ONLY_SIZE;
                const VehicleIcon = s.vehicle === "moto" ? Bike : Car;
                return (
                  <button
                    key={s.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={locked}
                    onClick={() => setPackageSize(s.value)}
                    title={locked ? "Tu tienda envía siempre en auto" : s.hint}
                    style={{
                      position: "relative", textAlign: "left", cursor: locked ? "not-allowed" : "pointer",
                      opacity: locked ? 0.45 : 1,
                      padding: "12px", borderRadius: "10px", fontFamily: FONT,
                      border: `1.5px solid ${selected ? F.brand : F.border}`,
                      background: selected ? F.brandTint : F.surface,
                      display: "flex", flexDirection: "column", gap: "4px",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px" }}>
                      <span style={{ fontSize: "14px", fontWeight: 600, color: selected ? F.brand : F.ink }}>{s.label}</span>
                      {selected && (
                        <span style={{
                          width: "18px", height: "18px", borderRadius: "50%", background: F.brand,
                          display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                        }}>
                          <Check size={12} color="#FFFFFF" strokeWidth={3} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: "12px", color: F.muted }}>Hasta {s.maxKg.toLocaleString("es-CL")} kg</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px", color: F.muted }}>
                      <VehicleIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                      {VEHICLE_LABEL[s.vehicle]}
                    </span>
                    {suggested && (
                      <span style={{
                        alignSelf: "flex-start", marginTop: "4px", fontSize: "11px", fontWeight: 600,
                        color: F.success, background: F.successTint, borderRadius: "99px", padding: "2px 8px",
                      }}>
                        Sugerido por peso
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: "12px", color: F.muted, marginTop: "10px", lineHeight: 1.6 }}>
              {carOnly
                ? <>Tu tienda está configurada para enviar <strong style={{ color: F.ink, fontWeight: 600 }}>siempre en auto</strong>, así que el pedido va como Extra grande. Puedes cambiarlo en Configuración → Vehículo para tus envíos.</>
                : totalGrams > 0
                ? <>Sugerimos el tamaño según el peso total del pedido. Si el paquete es más voluminoso que pesado, elige uno más grande.</>
                : <>Los productos no tienen peso cargado en Shopify, así que no podemos sugerir un tamaño. Elígelo a mano.</>}
              {!carOnly && <>{" "}Uber Direct usa el tamaño para asignar el vehículo; solo Extra grande asegura un auto.</>}
            </div>
          </div>
        </div>

        {/* Simulador de pruebas — solo tiendas en modo prueba (robo-courier de Uber) */}
        {testShop && (
          <div style={{ background: F.surface, borderRadius: "12px", border: `1.5px dashed ${F.warning}`, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.warningTint, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: "#92400E", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Simulador de pruebas
              </span>
              <span style={{ fontSize: "11px", color: "#92400E" }}>Modo prueba · sin conductor real ni cobro</span>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <div id="test-scenario-label" style={{ fontSize: "13px", fontWeight: 600, color: F.ink, marginBottom: "8px" }}>
                  ¿Qué quieres que pase con este envío?
                </div>
                <div role="radiogroup" aria-labelledby="test-scenario-label" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" }}>
                  {TEST_SCENARIOS.map((sc) => {
                    const selected = testScenario === sc.value;
                    return (
                      <button
                        key={sc.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setTestScenario(sc.value)}
                        style={{
                          textAlign: "left", cursor: "pointer", padding: "10px 12px", borderRadius: "10px", fontFamily: FONT,
                          border: `1.5px solid ${selected ? F.brand : F.border}`,
                          background: selected ? F.brandTint : F.surface,
                          display: "flex", flexDirection: "column", gap: "2px",
                        }}
                      >
                        <span style={{ fontSize: "13px", fontWeight: 600, color: selected ? F.brand : F.ink }}>{sc.label}</span>
                        <span style={{ fontSize: "12px", color: F.muted }}>{sc.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {isCancelScenario(testScenario) && (
                <div>
                  <div id="undeliverable-label" style={{ fontSize: "13px", fontWeight: 600, color: F.ink, marginBottom: "8px" }}>
                    Si no puede entregar, el conductor debe…
                  </div>
                  <div role="radiogroup" aria-labelledby="undeliverable-label" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                    {UNDELIVERABLE_ACTIONS.map((a) => {
                      const selected = undeliverableAction === a.value;
                      return (
                        <button
                          key={a.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setUndeliverableAction(a.value)}
                          style={{
                            cursor: "pointer", padding: "8px 14px", borderRadius: "99px", fontFamily: FONT, fontSize: "13px", fontWeight: 600,
                            border: `1.5px solid ${selected ? F.brand : F.border}`,
                            background: selected ? F.brandTint : F.surface,
                            color: selected ? F.brand : F.text,
                          }}
                        >
                          {a.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{ fontSize: "12px", color: F.muted, lineHeight: 1.6 }}>
                El conductor de prueba de Uber siempre llega en el mismo auto de ejemplo: el vehículo no depende del tamaño ni del peso.
              </div>
            </div>
          </div>
        )}

        {/* Cotización */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Cotización Uber Direct
            </span>
          </div>
          <div style={{ padding: "18px" }}>
            {!order.shippingAddress ? (
              <div style={{ color: F.muted, fontSize: "14px" }}>Esta orden no tiene dirección de entrega.</div>
            ) : (
              <div>
                {/* Quote o error */}
                {quoteError ? (
                  <div style={{ background: F.warningTint, border: `1px solid #FDE68A`, borderRadius: "8px", padding: "13px 16px", color: "#92400E", fontSize: "13px", marginBottom: "16px" }}>
                    ⚠️ No se pudo obtener cotización: {quoteError}
                    <div style={{ marginTop: "4px", fontSize: "12px" }}>Sin cotización no se puede crear el envío, para que no se cobre un precio que no viste. Recarga la página para intentar de nuevo.</div>
                  </div>
                ) : quote ? (
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "10px" }}>
                      <div style={{ background: F.brandTint, borderRadius: "10px", padding: "16px", textAlign: "center" }}>
                        <div style={{ fontSize: "11px", fontWeight: "700", color: F.brand, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>Costo del envío</div>
                        <div style={{ fontSize: "28px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>{formattedFee}</div>
                        <div style={{ fontSize: "10px", color: F.muted, marginTop: "4px" }}>Lo pagas tú a Uber</div>
                      </div>
                      <div style={{ background: F.bg, borderRadius: "10px", padding: "16px", textAlign: "center", border: `1px solid ${F.border}` }}>
                        <div style={{ fontSize: "11px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>Tiempo estimado</div>
                        <div style={{ fontSize: "28px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>{quote.duration} <span style={{ fontSize: "16px", color: F.muted }}>min</span></div>
                      </div>
                    </div>
                    {quote.expires && (
                      <div style={{ fontSize: "12px", color: F.muted, textAlign: "center" }}>
                        Cotización válida hasta las {formatTimeCL(new Date(quote.expires))} — confirma antes de que expire
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Botón siempre visible si hay dirección */}
                <Form method="post">
                  <input type="hidden" name="quoteId" value={quote?.id ?? ""} />
                  <input type="hidden" name="quotedFee" value={quote?.fee ?? ""} />
                  <input type="hidden" name="manualPhone" value={manualPhone} />
                  <input type="hidden" name="dropoffNotes" value={order.note ?? ""} />
                  <input type="hidden" name="packageSize" value={packageSize} />
                  {testShop && (
                    <>
                      <input type="hidden" name="testScenario" value={testScenario} />
                      <input type="hidden" name="undeliverableAction" value={undeliverableAction} />
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => { if (canSubmit) setShowConfirm(true); }}
                    disabled={!canSubmit}
                    style={{
                      width: "100%", padding: "13px",
                      background: !canSubmit ? "#9b85ec" : F.brand,
                      color: "#fff", border: "none", borderRadius: "8px",
                      fontSize: "15px", fontWeight: "600",
                      cursor: !canSubmit ? "not-allowed" : "pointer",
                      boxShadow: !canSubmit ? "none" : "0 2px 10px rgba(75,43,224,0.3)",
                      ...font,
                    }}
                  >
                    {priceChanged ? `Confirmar con el nuevo precio (${formattedFee}) →` : "Confirmar y crear envío →"}
                  </button>
                  {!effectivePhone && (
                    <div style={{ textAlign: "center", fontSize: "12px", color: F.muted, marginTop: "8px" }}>
                      Ingresa el teléfono del cliente arriba para continuar
                    </div>
                  )}

                  {/* Modal de confirmación — evita despachos accidentales */}
                  {showConfirm && (
                    <div
                      onClick={() => { if (!confirming) setShowConfirm(false); }}
                      style={{
                        position: "fixed", inset: 0, background: "rgba(15,12,40,0.55)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        padding: "20px", zIndex: 1000,
                      }}
                    >
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          background: F.surface, borderRadius: "14px", padding: "26px 24px",
                          maxWidth: "380px", width: "100%", textAlign: "center",
                          boxShadow: "0 20px 60px rgba(15,12,40,0.35)", ...font,
                        }}
                      >
                        <div style={{ fontSize: "40px", marginBottom: "8px" }}>🛵</div>
                        <h3 style={{ fontSize: "18px", fontWeight: 700, color: F.ink, margin: "0 0 8px", fontFamily: DISPLAY_FONT }}>
                          ¿Crear el envío ahora?
                        </h3>
                        <p style={{ fontSize: "13px", color: F.muted, lineHeight: 1.6, margin: "0 0 20px" }}>
                          {testShop ? (
                            <>Envío de prueba: <strong>{TEST_SCENARIOS.find((sc) => sc.value === testScenario)?.label}</strong>.
                            Lo hace el conductor de prueba de Uber, sin cobro.</>
                          ) : (
                            <>Uber Direct le cobrará <strong>{formattedFee}</strong> a tu cuenta y asignará un repartidor
                            de inmediato para retirar en tu tienda. Esta acción no se puede deshacer.</>
                          )}
                        </p>
                        <div style={{ display: "flex", gap: "10px" }}>
                          <button
                            type="button"
                            onClick={() => setShowConfirm(false)}
                            disabled={confirming}
                            style={{
                              flex: 1, padding: "12px", background: F.surface, color: F.text,
                              border: `1.5px solid ${F.border}`, borderRadius: "9px",
                              fontSize: "14px", fontWeight: 600, cursor: confirming ? "not-allowed" : "pointer", ...font,
                            }}
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            disabled={confirming}
                            style={{
                              flex: 1, padding: "12px", background: confirming ? "#9b85ec" : F.brand,
                              color: "#fff", border: "none", borderRadius: "9px",
                              fontSize: "14px", fontWeight: 600, cursor: confirming ? "not-allowed" : "pointer", ...font,
                            }}
                          >
                            {confirming ? "Creando..." : "Sí, crear envío →"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </Form>
              </div>
            )}
          </div>
        </div>

        <Link to="/app" style={{ fontSize: "13px", color: F.muted, textDecoration: "none", textAlign: "center" }}>
          ← Volver a órdenes
        </Link>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
