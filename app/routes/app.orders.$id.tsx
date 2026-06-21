import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getDeliveryQuote, createDelivery, uberCredsFromConfig } from "../services/uber-direct.server";
import { checkPlanLimit } from "../lib/plan-limits.server";
import { PACKAGE_SIZES, toPackageSize } from "../lib/package-size";
import { normalizeChileanPhone } from "../lib/phone";
import { fulfillOrderWithTracking } from "../lib/fulfillment.server";
import { isUberTestShop } from "../lib/test-shops.server";
import { colors as F, FONT, DISPLAY_FONT } from "../lib/theme";

type ShopifyOrder = {
  id: string; name: string; note: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  phone: string | null;
  shippingAddress: { name: string; address1: string; city: string; province: string | null; zip: string; phone: string | null } | null;
  billingAddress: { phone: string | null } | null;
  lineItems: { edges: Array<{ node: { title: string; quantity: number } }> };
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
        lineItems(first: 10) { edges { node { title quantity } } }
      }
    }
  `, { variables: { id: `gid://shopify/Order/${orderId}` } });
  const json = await res.json();
  return json.data?.order ?? null;
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
  const formattedFee = quote ? `$${(quote.fee / 100).toFixed(0)} ${quote.currency}` : null;

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

  return { order, storeConfig, quote, quoteError, orderId, formattedTotal, formattedFee, customerPhone, missingPhone, storePhone };
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

  const { allowed, used, limit } = await checkPlanLimit(session.shop);
  if (!allowed) {
    return {
      error: `Alcanzaste el límite de ${limit} envíos del plan ${storeConfig.plan === "starter" ? "Starter" : "actual"}. Actualiza tu plan para continuar.`,
    };
  }

  const formData = await request.formData();
  const quoteId = formData.get("quoteId") as string;
  const manualPhone = formData.get("manualPhone") as string;
  const dropoffNotes = ((formData.get("dropoffNotes") as string) || "").trim() || undefined;
  const pickupNotes = storeConfig.pickupNotes || undefined;
  const packageSize = toPackageSize(formData.get("packageSize") || storeConfig.packageSize);
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
  const manifestItems = order.lineItems.edges.map((e) => ({ name: e.node.title, quantity: e.node.quantity, size: packageSize }));
  // Robo-courier de Uber (sandbox) SOLO para la tienda de review de Shopify.
  const testMode = isUberTestShop(session.shop);

  let activeQuoteId = quoteId;
  let delivery;
  try {
    delivery = await createDelivery(creds, {
      quoteId: activeQuoteId,
      pickupName: storeConfig.contactName, pickupAddress, pickupPhone: storeConfig.phone, pickupNotes,
      dropoffName: order.shippingAddress.name, dropoffAddress, dropoffPhone, dropoffNotes, manifestItems,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // Si el quote expiró, obtener uno nuevo y reintentar una vez
    if (msg.toLowerCase().includes("expired") || msg.includes("quote") || msg.includes("422") || msg.includes("invalid")) {
      try {
        const freshQuote = await getDeliveryQuote(creds, { pickupAddress, dropoffAddress });
        delivery = await createDelivery(creds, {
          quoteId: freshQuote.id,
          pickupName: storeConfig.contactName, pickupAddress, pickupPhone: storeConfig.phone, pickupNotes,
          dropoffName: order.shippingAddress.name, dropoffAddress, dropoffPhone, dropoffNotes, manifestItems, testMode,
        });
      } catch (e2) {
        return { error: e2 instanceof Error ? e2.message : "Error al crear el envío en Uber Direct." };
      }
    } else {
      return { error: msg || "Error al crear el envío en Uber Direct." };
    }
  }

  // Borrar cualquier registro fallido previo del auto-despacho
  await db.delivery.deleteMany({ where: { orderId: order.id, shop: session.shop, status: "failed" } });

  await db.delivery.create({
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

  throw redirect("/app");
};

export default function OrderDetail() {
  const { order, storeConfig, quote, quoteError, formattedTotal, formattedFee, customerPhone, storePhone } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const confirming = navigation.state === "submitting";
  const font = { fontFamily: FONT };
  // Si la orden no trae teléfono del cliente, pre-llenamos con el de la tienda
  // (Uber lo necesita sí o sí). El merchant puede cambiarlo antes de despachar.
  const [manualPhone, setManualPhone] = useState(customerPhone ? "" : (storePhone ?? ""));
  const [notes, setNotes] = useState(order.note ?? "");
  const [packageSize, setPackageSize] = useState(storeConfig.packageSize ?? "small");
  const effectivePhone = customerPhone || manualPhone;
  const canSubmit = !!effectivePhone && !!quote;

  return (
    <s-page heading={order.name}>
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", ...font }}>

        {actionData?.error && (
          <div style={{
            background: F.dangerTint, border: `1px solid #FECACA`,
            borderRadius: "10px", padding: "13px 16px",
            color: F.danger, fontSize: "14px", display: "flex", gap: "8px",
          }}>
            ⚠️ {actionData.error}
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
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                📦 Preparar para envío
              </span>
              <div style={{ fontSize: "12px", color: F.muted, marginTop: "2px" }}>
                Esto es lo que el cliente compró
              </div>
            </div>
            <span style={{ fontSize: "15px", fontWeight: "700", color: F.ink }}>{formattedTotal}</span>
          </div>
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: "10px" }}>
            {order.lineItems.edges.map(({ node }) => (
              <div key={node.title} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div style={{
                    width: "32px", height: "32px", background: F.brandTint,
                    borderRadius: "6px", display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: "14px", flexShrink: 0,
                  }}>📦</div>
                  <span style={{ fontSize: "14px", fontWeight: "500", color: F.text }}>{node.title}</span>
                </div>
                <span style={{
                  fontSize: "13px", fontWeight: "700", color: F.ink,
                  background: F.bg, padding: "3px 10px", borderRadius: "99px",
                  border: `1px solid ${F.border}`, flexShrink: 0,
                }}>
                  ×{node.quantity}
                </span>
              </div>
            ))}
            <div style={{
              marginTop: "4px", paddingTop: "14px", borderTop: `1px solid ${F.border}`,
            }}>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: F.text, marginBottom: "6px" }}>
                Tamaño del paquete
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "6px" }}>
                {PACKAGE_SIZES.map((s) => {
                  const selected = packageSize === s.value;
                  return (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => setPackageSize(s.value)}
                      title={s.hint}
                      style={{
                        padding: "8px 6px", textAlign: "center", cursor: "pointer",
                        borderRadius: "8px", fontSize: "12px", fontWeight: "600",
                        border: `1.5px solid ${selected ? F.brand : F.border}`,
                        background: selected ? F.brandTint : F.surface,
                        color: selected ? F.brand : F.muted,
                        fontFamily: FONT,
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: "12px", color: F.muted, marginTop: "8px" }}>
                Esta descripción y el tamaño se envían a Uber Direct como contenido del paquete.
              </div>
            </div>
          </div>
        </div>

        {/* Instrucciones para la entrega (dropoff) */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Instrucciones de entrega del cliente
            </span>
            <div style={{ fontSize: "12px", color: F.muted, marginTop: "2px" }}>
              Tomadas de la nota del pedido. Edítalas solo si necesitas precisar algo para el courier.
            </div>
          </div>
          <div style={{ padding: "18px" }}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="El cliente no dejó instrucciones de entrega. Puedes agregar una si la conoces."
              rows={2}
              style={{
                width: "100%", padding: "10px 12px", border: `1.5px solid ${F.border}`,
                borderRadius: "8px", fontSize: "13px", color: F.text, background: F.surface,
                outline: "none", resize: "vertical", boxSizing: "border-box",
                fontFamily: FONT,
              }}
            />
          </div>
        </div>

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
                    <div style={{ marginTop: "4px", fontSize: "12px" }}>Puedes igual crear el envío y Uber Direct calculará el costo.</div>
                  </div>
                ) : quote ? (
                  <div style={{ marginBottom: "20px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "10px" }}>
                      <div style={{ background: F.brandTint, borderRadius: "10px", padding: "16px", textAlign: "center" }}>
                        <div style={{ fontSize: "11px", fontWeight: "700", color: F.brand, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>Costo del envío</div>
                        <div style={{ fontSize: "28px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>{formattedFee}</div>
                      </div>
                      <div style={{ background: F.bg, borderRadius: "10px", padding: "16px", textAlign: "center", border: `1px solid ${F.border}` }}>
                        <div style={{ fontSize: "11px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>Tiempo estimado</div>
                        <div style={{ fontSize: "28px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>{quote.duration} <span style={{ fontSize: "16px", color: F.muted }}>min</span></div>
                      </div>
                    </div>
                    {quote.expires && (
                      <div style={{ fontSize: "12px", color: F.muted, textAlign: "center" }}>
                        Cotización válida hasta las {new Date(quote.expires).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} — confirma antes de que expire
                      </div>
                    )}
                  </div>
                ) : null}

                {/* Botón siempre visible si hay dirección */}
                <Form method="post">
                  <input type="hidden" name="quoteId" value={quote?.id ?? ""} />
                  <input type="hidden" name="manualPhone" value={manualPhone} />
                  <input type="hidden" name="dropoffNotes" value={notes} />
                  <input type="hidden" name="packageSize" value={packageSize} />
                  <button
                    type="submit"
                    disabled={confirming || !effectivePhone}
                    style={{
                      width: "100%", padding: "13px",
                      background: (confirming || !effectivePhone) ? "#9b85ec" : F.brand,
                      color: "#fff", border: "none", borderRadius: "8px",
                      fontSize: "15px", fontWeight: "600",
                      cursor: (confirming || !effectivePhone) ? "not-allowed" : "pointer",
                      boxShadow: (confirming || !effectivePhone) ? "none" : "0 2px 10px rgba(75,43,224,0.3)",
                      ...font,
                    }}
                  >
                    {confirming ? "Creando envío..." : "Confirmar y crear envío →"}
                  </button>
                  {!effectivePhone && (
                    <div style={{ textAlign: "center", fontSize: "12px", color: F.muted, marginTop: "8px" }}>
                      Ingresa el teléfono del cliente arriba para continuar
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
