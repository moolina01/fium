import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { authenticate, registerCarrierService } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getDelivery, cancelDelivery, getStoreUberCreds, type UberCreds } from "../services/uber-direct.server";
import { getSetupChecklist, type SetupChecklist } from "../lib/setup.server";
import { logError } from "../lib/logger.server";
import { FONT } from "../lib/theme";

type Order = {
  id: string;
  name: string;
  timeAgo: string;
  orderId: string;
  customerName: string;
  address: string;
  city: string;
  autoDispatchFailed: boolean;
};

type ActiveDelivery = {
  id: string;
  orderNumber: string;
  customerName: string;
  customerAddress: string;
  customerComuna: string;
  status: string;
  uberTrackingUrl: string | null;
  timeAgo: string;
};

type HistoryDelivery = ActiveDelivery;

function calcTimeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  return `hace ${Math.floor(hrs / 24)}d`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);

  const config = await db.storeConfig.findUnique({ where: { shop: session.shop } });
  if (!config) throw redirect("/app/onboarding");

  // Estado de setup — si el carrier no está registrado, Fium no aparece en el checkout
  const setup = await getSetupChecklist(session.shop, session.accessToken!);

  // Paginar las órdenes sin despachar (Shopify limita a 250 por página).
  // Solo miramos los últimos 30 días: Fium es entrega same-day, una orden más
  // vieja que eso no es candidata a despacho y solo haría el scan más pesado.
  // Con esa ventana el cap de 5 páginas casi nunca se alcanza.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const ordersQuery = `fulfillment_status:unfulfilled status:open created_at:>=${since}`;
  const raw: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const res: any = await admin.graphql(`
      #graphql
      query GetUnfulfilledOrders($cursor: String, $query: String) {
        orders(first: 250, after: $cursor, query: $query) {
          edges {
            node {
              id name createdAt
              shippingAddress { name address1 city zip }
              shippingLines(first: 1) { edges { node { title } } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { variables: { cursor, query: ordersQuery } });
    const json = await res.json();
    const ordersData = json.data?.orders;
    raw.push(...(ordersData?.edges ?? []));
    if (!ordersData?.pageInfo?.hasNextPage) break;
    cursor = ordersData.pageInfo.endCursor;
  }

  const deliveries = await db.delivery.findMany({ where: { shop: session.shop } });

  // Sync con Uber SOLO como fallback de webhooks: los webhooks de Uber ya
  // actualizan el estado (y el updatedAt) en tiempo real, así que un delivery
  // refrescado hace poco no necesita consultarse. Solo sincronizamos los
  // "obsoletos" (sin actualizar en >5 min) y como mucho 15, para que el loader
  // no haga decenas de llamadas a Uber en cada carga.
  const STALE_MS = 5 * 60 * 1000;
  // Credenciales de Uber de la tienda — si aún no conectó su cuenta, no sincronizamos.
  let uberCreds: UberCreds | null = null;
  try {
    uberCreds = await getStoreUberCreds(session.shop);
  } catch {
    uberCreds = null;
  }
  const nonTerminal = (uberCreds ? deliveries : [])
    .filter(
      (d: any) =>
        !["delivered", "canceled", "returned"].includes(d.status) &&
        d.uberDeliveryId &&
        Date.now() - new Date(d.updatedAt).getTime() > STALE_MS
    )
    .slice(0, 15);
  await Promise.allSettled(
    nonTerminal.map(async (d: any) => {
      try {
        const live = await getDelivery(uberCreds!, d.uberDeliveryId);
        if (live.status !== d.status) {
          await db.delivery.update({
            where: { id: d.id },
            data: {
              status: live.status,
              ...(live.trackingUrl ? { uberTrackingUrl: live.trackingUrl } : {}),
            },
          });
          d.status = live.status;
          if (live.trackingUrl) d.uberTrackingUrl = live.trackingUrl;
        }
      } catch (err) {
        // Mantener el status cacheado si Uber no responde — no rompe el dashboard
        logError("dashboard/sync-delivery", err, { deliveryId: d.id });
      }
    })
  );

  // failed se excluye: la orden debe reaparecer en "Por despachar" para despacho manual
  const deliveredOrderIds = new Set(
    deliveries.filter((d: any) => d.status !== "failed").map((d: any) => d.orderId)
  );
  const failedOrderIds = new Set(
    deliveries.filter((d: any) => d.status === "failed").map((d: any) => d.orderId)
  );
  const todayStr = new Date().toDateString();

  // Órdenes Shopify sin delivery creado aún (+ las que fallaron en auto-dispatch)
  const pendingOrders: Order[] = raw
    .filter((e: any) =>
      e.node.shippingLines.edges.some((s: any) => {
        const title = s.node.title.toLowerCase();
        return (title.includes("uber") || title.includes("fium")) && !deliveredOrderIds.has(e.node.id);
      })
    )
    .map((e: any) => ({
      id: e.node.id,
      name: e.node.name,
      timeAgo: calcTimeAgo(e.node.createdAt),
      orderId: (e.node.id as string).split("/").pop() ?? "",
      customerName: e.node.shippingAddress?.name ?? "Sin nombre",
      address: e.node.shippingAddress?.address1 ?? "",
      city: e.node.shippingAddress?.city ?? "",
      autoDispatchFailed: failedOrderIds.has(e.node.id),
    }));

  // Deliveries activos — excluye failed (ya aparecen en "Por despachar")
  const activeDeliveries: ActiveDelivery[] = deliveries
    .filter((d: any) => !["delivered", "canceled", "returned", "failed"].includes(d.status))
    .map((d: any) => ({
      id: d.id,
      orderNumber: d.orderNumber,
      customerName: d.customerName,
      customerAddress: d.customerAddress,
      customerComuna: d.customerComuna,
      status: d.status,
      uberTrackingUrl: d.uberTrackingUrl ?? null,
      timeAgo: calcTimeAgo(d.createdAt.toString()),
    }));

  // Historial — deliveries en estado terminal, más recientes primero
  const history: HistoryDelivery[] = deliveries
    .filter((d: any) => ["delivered", "canceled", "returned"].includes(d.status))
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50)
    .map((d: any) => ({
      id: d.id,
      orderNumber: d.orderNumber,
      customerName: d.customerName,
      customerAddress: d.customerAddress,
      customerComuna: d.customerComuna,
      status: d.status,
      uberTrackingUrl: d.uberTrackingUrl ?? null,
      timeAgo: calcTimeAgo(d.createdAt.toString()),
    }));

  return {
    hasConfig: true,
    pendingOrders,
    activeDeliveries,
    history,
    active: deliveries.filter((d: any) =>
      ["pending", "pickup", "pickup_complete", "dropoff"].includes(d.status)
    ).length,
    delivered: deliveries.filter(
      (d: any) => d.status === "delivered" && new Date(d.createdAt).toDateString() === todayStr
    ).length,
    issues: deliveries.filter((d: any) => d.status === "failed").length,
    setup,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "ack_phone_required") {
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { phoneRequiredAck: true },
    });
    return { ok: true };
  }

  if (intent === "ack_carrier_activated") {
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { carrierActivatedAck: true },
    });
    return { ok: true };
  }

  if (intent === "register_carrier") {
    try {
      const result = await registerCarrierService(session.shop, session.accessToken!);
      if (result.ok || result.alreadyExists) return { ok: true };
      return { error: "No se pudo activar Fium en el checkout. Revisa que tu plan de Shopify permita tarifas calculadas por terceros." };
    } catch (e) {
      logError("dashboard/register-carrier", e, { shop: session.shop });
      return { error: "Error al activar Fium en el checkout. Intenta de nuevo." };
    }
  }

  if (intent === "cancel_delivery") {
    const deliveryId = formData.get("deliveryId") as string;
    const delivery = await db.delivery.findFirst({ where: { id: deliveryId, shop: session.shop } });
    if (!delivery?.uberDeliveryId) return { error: "Envío no encontrado." };
    try {
      const creds = await getStoreUberCreds(session.shop);
      await cancelDelivery(creds, delivery.uberDeliveryId);
      await db.delivery.update({ where: { id: deliveryId }, data: { status: "canceled" } });
      return { ok: true };
    } catch (e) {
      logError("dashboard/cancel-delivery", e, { deliveryId, shop: session.shop });
      const msg = e instanceof Error ? e.message : "No se pudo cancelar.";
      return { error: msg };
    }
  }

  return { error: "Acción desconocida." };
};

const T = { fontFamily: FONT };

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const [tab, setTab] = useState<"pending" | "confirmed" | "history">("pending");
  const { pendingOrders, activeDeliveries, history, active, delivered, issues, setup } = data;

  return (
    <s-page heading="Órdenes">
      {/* Banner de setup incompleto — Fium no aparece en el checkout hasta completarlo */}
      {!setup.complete && (
        <s-section>
          <SetupBanner setup={setup} />
        </s-section>
      )}

      {/* Header con Uber Direct */}
      <s-section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", ...T }}>
          <div>
            <div style={{ fontSize: "13px", color: "#6b7280" }}>
              Envíos express gestionados vía{" "}
              <span style={{ color: "#111827", fontWeight: "600" }}>Uber Direct</span>
            </div>
          </div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "6px",
            background: "#f9fafb", border: "1px solid #e5e7eb",
            borderRadius: "6px", padding: "5px 10px",
          }}>
            <span style={{
              width: "7px", height: "7px", borderRadius: "50%",
              background: "#1D9E75", display: "inline-block",
            }} />
            <span style={{ fontSize: "12px", color: "#374151", fontWeight: "500" }}>Uber Direct activo</span>
          </div>
        </div>
      </s-section>

      {/* Métricas */}
      <s-section>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
          borderRadius: "10px", border: "1px solid #e5e7eb",
          overflow: "hidden", ...T,
        }}>
          {([
            [String(active),    "En curso",        "#4B2BE0"],
            [String(delivered), "Entregadas hoy",  "#1D9E75"],
            [String(issues),    "Con problemas",   "#DC2626"],
          ] as const).map(([value, label, color], i) => (
            <div key={label} style={{
              padding: "20px 24px",
              borderRight: i < 2 ? "1px solid #e5e7eb" : "none",
              background: "white",
            }}>
              <div style={{ fontSize: "28px", fontWeight: "700", color, letterSpacing: "-1px", lineHeight: 1 }}>
                {value}
              </div>
              <div style={{ fontSize: "13px", color: "#6b7280", marginTop: "4px" }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      </s-section>

      {/* Tabla */}
      <s-section>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: "0", ...T }}>
          {([
            { key: "pending",   label: "Por despachar", count: pendingOrders.length },
            { key: "confirmed", label: "En curso",      count: activeDeliveries.length },
            { key: "history",   label: "Historial",     count: history.length },
          ] as const).map(({ key, label, count }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                padding: "10px 16px", border: "none", background: "transparent",
                fontSize: "13px", fontWeight: "600", cursor: "pointer", ...T,
                color: tab === key ? "#111827" : "#9ca3af",
                borderBottom: tab === key ? "2px solid #4B2BE0" : "2px solid transparent",
                marginBottom: "-1px", display: "flex", alignItems: "center", gap: "6px",
              }}
            >
              {label}
              <span style={{
                background: tab === key ? "#EEEDFE" : "#f3f4f6",
                color: tab === key ? "#4B2BE0" : "#9ca3af",
                fontSize: "11px", fontWeight: "700",
                padding: "1px 6px", borderRadius: "4px",
              }}>
                {count}
              </span>
            </button>
          ))}
        </div>

        {tab === "pending" && (
          pendingOrders.length === 0
            ? <EmptyState
                title="Aún no hay pedidos por despachar"
                text="Cuando un cliente elija Fium en el checkout, su pedido aparecerá aquí listo para despachar con un clic."
              />
            : <OrderTable orders={pendingOrders} />
        )}
        {tab === "confirmed" && (
          activeDeliveries.length === 0
            ? <EmptyState
                title="No hay envíos en curso"
                text="Los envíos que despaches aparecerán aquí con su estado en tiempo real, desde que el courier los retira hasta la entrega."
              />
            : <DeliveryTable deliveries={activeDeliveries} />
        )}
        {tab === "history" && (
          history.length === 0
            ? <EmptyState
                title="Aún no hay envíos completados"
                text="Aquí verás el historial de tus entregas, cancelaciones y devoluciones."
              />
            : <HistoryTable deliveries={history} />
        )}
      </s-section>
    </s-page>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ padding: "48px 24px", textAlign: "center", ...T }}>
      <div style={{ fontSize: "14px", fontWeight: "600", color: "#374151", marginBottom: "4px" }}>{title}</div>
      <div style={{ fontSize: "13px", color: "#9ca3af", maxWidth: "380px", margin: "0 auto", lineHeight: "1.5" }}>{text}</div>
    </div>
  );
}

function SetupBanner({ setup }: { setup: SetupChecklist }) {
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const busy = fetcher.state !== "idle";
  const carrierAckFetcher = useFetcher<{ ok?: boolean }>();
  const carrierAckBusy = carrierAckFetcher.state !== "idle";
  const phoneFetcher = useFetcher<{ ok?: boolean }>();
  const phoneBusy = phoneFetcher.state !== "idle";
  const carrierStep = setup.steps.find((s) => s.key === "carrier");
  const phoneStep = setup.steps.find((s) => s.key === "phone");

  return (
    <div style={{
      background: "white", border: "2px solid #4B2BE0", borderRadius: "12px",
      overflow: "hidden", ...T,
    }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ fontSize: "15px", fontWeight: "700", color: "#111827" }}>
          Termina de configurar Fium
        </div>
        <div style={{ fontSize: "13px", color: "#6b7280", marginTop: "2px" }}>
          Completa estos pasos para que tus clientes puedan elegir Fium y los envíos funcionen sin problemas.
        </div>
      </div>

      {/* Checklist */}
      <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {setup.steps.map((s) => (
          <div key={s.key} style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
            <div style={{
              width: "20px", height: "20px", borderRadius: "50%", flexShrink: 0, marginTop: "1px",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "12px", fontWeight: "700",
              background: s.done ? "#1D9E75" : "#f3f4f6",
              color: s.done ? "white" : "#9ca3af",
            }}>
              {s.done ? "✓" : ""}
            </div>
            <div>
              <div style={{ fontSize: "13px", fontWeight: "600", color: s.done ? "#9ca3af" : "#111827", textDecoration: s.done ? "line-through" : "none" }}>
                {s.label}
              </div>
              <div style={{ fontSize: "12px", color: "#9ca3af" }}>{s.description}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Acción para el carrier — mismo formato que el paso del teléfono.
          Ojo: el carrier service se registra solo al instalar (afterAuth), por eso
          el paso NO se marca hecho por estar registrado, sino cuando el merchant
          confirma ("Ya lo activé") o Shopify pide tarifas en vivo (carrierLiveAt). */}
      {carrierStep && !carrierStep.done && (
        <div style={{ padding: "0 20px 18px", borderTop: "1px solid #f3f4f6", paddingTop: "16px" }}>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#111827", marginBottom: "4px" }}>
            Activa Fium en el checkout de Shopify
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "10px", lineHeight: "1.6", maxWidth: "520px" }}>
            Para que Fium aparezca como opción de envío, agrégalo a tu zona de envío:
            en Shopify ve a <strong style={{ color: "#374151" }}>Configuración → Envío y entrega</strong>, abre tu zona
            de envío y agrega la tarifa <strong style={{ color: "#374151" }}>Fium</strong> (aparece en la lista de
            transportistas). Luego confirma aquí.
          </div>
          {fetcher.data?.error && (
            <div style={{ fontSize: "12px", color: "#DC2626", marginBottom: "10px" }}>
              ⚠️ {fetcher.data.error}
            </div>
          )}
          <carrierAckFetcher.Form method="post">
            <input type="hidden" name="intent" value="ack_carrier_activated" />
            <button type="submit" disabled={carrierAckBusy} style={{
              padding: "10px 18px",
              background: "white", color: "#4B2BE0",
              border: "1.5px solid #4B2BE0", borderRadius: "8px",
              fontSize: "13px", fontWeight: "600", cursor: carrierAckBusy ? "not-allowed" : "pointer", ...T,
            }}>
              {carrierAckBusy ? "Guardando..." : "Ya lo activé en Shopify"}
            </button>
          </carrierAckFetcher.Form>
          {/* Fallback discreto: re-registrar si Fium no aparece en la lista (raro). */}
          <fetcher.Form method="post" style={{ marginTop: "10px" }}>
            <input type="hidden" name="intent" value="register_carrier" />
            <button type="submit" disabled={busy} style={{
              padding: "0", background: "none", border: "none",
              color: "#9ca3af", textDecoration: "underline",
              fontSize: "12px", cursor: busy ? "not-allowed" : "pointer", ...T,
            }}>
              {busy ? "Registrando..." : "¿Fium no aparece en la lista? Vuelve a registrarlo"}
            </button>
          </fetcher.Form>
        </div>
      )}

      {/* Confirmación en vivo — Shopify ya pide tarifas de Fium en el checkout */}
      {carrierStep && carrierStep.done && setup.carrierLiveAt && (
        <div style={{ padding: "0 20px 18px" }}>
          <div style={{
            background: "#E6F7F2", border: "1px solid #A7E6C8", borderRadius: "8px",
            padding: "10px 14px", fontSize: "12px", color: "#0F7355", lineHeight: "1.6",
          }}>
            ✅ <strong>Activo en tu checkout.</strong> Shopify pidió cotizaciones de Fium {calcTimeAgo(setup.carrierLiveAt)}.
          </div>
        </div>
      )}

      {/* Acción para exigir teléfono */}
      {phoneStep && !phoneStep.done && (
        <div style={{ padding: "0 20px 18px", borderTop: carrierStep && !carrierStep.done ? "1px solid #f3f4f6" : "none", paddingTop: carrierStep && !carrierStep.done ? "16px" : "0" }}>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#111827", marginBottom: "4px" }}>
            Exige el teléfono del cliente en tu checkout
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "10px", lineHeight: "1.6", maxWidth: "520px" }}>
            Uber necesita el teléfono para cada envío. Si un cliente no lo deja, no podrás despachar su pedido.
            En Shopify ve a <strong style={{ color: "#374151" }}>Configuración → Pagos / Checkout → Información de contacto</strong> y
            marca el teléfono como <strong style={{ color: "#374151" }}>obligatorio</strong>. Luego confirma aquí.
          </div>
          <phoneFetcher.Form method="post">
            <input type="hidden" name="intent" value="ack_phone_required" />
            <button type="submit" disabled={phoneBusy} style={{
              padding: "10px 18px",
              background: "white", color: "#4B2BE0",
              border: "1.5px solid #4B2BE0", borderRadius: "8px",
              fontSize: "13px", fontWeight: "600", cursor: phoneBusy ? "not-allowed" : "pointer", ...T,
            }}>
              {phoneBusy ? "Guardando..." : "Ya lo configuré en Shopify"}
            </button>
          </phoneFetcher.Form>
        </div>
      )}
    </div>
  );
}

function OrderTable({ orders }: { orders: Order[] }) {
  return (
    <div style={{ ...T }}>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto",
        padding: "8px 16px", borderBottom: "1px solid #f3f4f6",
      }}>
        {["Orden", "Cliente", "Dirección", ""].map((h) => (
          <div key={h} style={{ fontSize: "11px", fontWeight: "600", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {h}
          </div>
        ))}
      </div>
      {orders.map((order) => (
        <div key={order.id} style={{
          borderBottom: "1px solid #f9fafb", background: "white",
        }}>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto",
            alignItems: "center", padding: "13px 16px",
          }}>
            <div>
              <span style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>{order.name}</span>
              <span style={{ fontSize: "12px", color: "#9ca3af", marginLeft: "8px" }}>{order.timeAgo}</span>
            </div>
            <div style={{ fontSize: "13px", color: "#374151" }}>{order.customerName}</div>
            <div style={{ fontSize: "13px", color: "#6b7280" }}>{order.address}, {order.city}</div>
            <div>
              <Link
                to={`/app/orders/${order.orderId}`}
                style={{
                  display: "inline-block", padding: "6px 14px",
                  background: order.autoDispatchFailed ? "#DC2626" : "#4B2BE0",
                  color: "white", borderRadius: "6px", fontSize: "12px", fontWeight: "600",
                  textDecoration: "none", whiteSpace: "nowrap",
                }}
              >
                {order.autoDispatchFailed ? "Reintentar envío" : "Enviar con Uber Direct"}
              </Link>
            </div>
          </div>
          {order.autoDispatchFailed && (
            <div style={{
              margin: "0 16px 10px",
              padding: "7px 12px",
              background: "#FEF2F2", borderRadius: "6px",
              fontSize: "12px", color: "#DC2626", fontWeight: "500",
            }}>
              El auto-despacho falló al contactar Uber Direct. Despacha manualmente.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DeliveryTable({ deliveries }: { deliveries: ActiveDelivery[] }) {
  return (
    <div style={{ ...T }}>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto",
        padding: "8px 16px", borderBottom: "1px solid #f3f4f6",
      }}>
        {["Orden", "Cliente", "Dirección", "Estado", ""].map((h) => (
          <div key={h} style={{ fontSize: "11px", fontWeight: "600", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {h}
          </div>
        ))}
      </div>
      {deliveries.map((d) => <DeliveryRow key={d.id} d={d} />)}
    </div>
  );
}

function DeliveryRow({ d }: { d: ActiveDelivery }) {
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== "idle";
  const canCancel = !["delivered", "canceled", "returned"].includes(d.status);

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto",
      alignItems: "center", padding: "13px 16px",
      borderBottom: "1px solid #f9fafb", background: "white",
    }}>
      <div>
        <span style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>{d.orderNumber}</span>
        <span style={{ fontSize: "12px", color: "#9ca3af", marginLeft: "8px" }}>{d.timeAgo}</span>
      </div>
      <div style={{ fontSize: "13px", color: "#374151" }}>{d.customerName}</div>
      <div style={{ fontSize: "13px", color: "#6b7280" }}>{d.customerAddress}, {d.customerComuna}</div>
      <div style={{ paddingRight: "16px" }}>
        <StatusDot status={d.status} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {d.uberTrackingUrl && (
            <a
              href={d.uberTrackingUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: "12px", color: "#4B2BE0", fontWeight: "600", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              Ver tracking
            </a>
          )}
          {canCancel && !confirming && (
            <button
              onClick={() => setConfirming(true)}
              style={{
                fontSize: "12px", color: "#9ca3af", fontWeight: "500",
                background: "none", border: "none", cursor: "pointer",
                padding: "0", whiteSpace: "nowrap", ...T,
              }}
            >
              Cancelar
            </button>
          )}
          {canCancel && confirming && (
            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
              <fetcher.Form method="post" style={{ display: "contents" }}>
                <input type="hidden" name="intent" value="cancel_delivery" />
                <input type="hidden" name="deliveryId" value={d.id} />
                <button
                  type="submit"
                  disabled={busy}
                  style={{
                    fontSize: "12px", fontWeight: "600", color: "white",
                    background: busy ? "#f87171" : "#DC2626",
                    border: "none", borderRadius: "5px",
                    padding: "4px 10px", cursor: busy ? "not-allowed" : "pointer", ...T,
                  }}
                >
                  {busy ? "..." : "Sí, cancelar"}
                </button>
              </fetcher.Form>
              <button
                onClick={() => setConfirming(false)}
                style={{
                  fontSize: "12px", color: "#6b7280", background: "none",
                  border: "none", cursor: "pointer", padding: "0", ...T,
                }}
              >
                No
              </button>
            </div>
          )}
        </div>
        {fetcher.data?.error && (
          <span style={{ fontSize: "11px", color: "#DC2626" }}>{fetcher.data.error}</span>
        )}
      </div>
    </div>
  );
}

function HistoryTable({ deliveries }: { deliveries: HistoryDelivery[] }) {
  return (
    <div style={{ ...T }}>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto",
        padding: "8px 16px", borderBottom: "1px solid #f3f4f6",
      }}>
        {["Orden", "Cliente", "Dirección", "Estado", ""].map((h) => (
          <div key={h} style={{ fontSize: "11px", fontWeight: "600", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {h}
          </div>
        ))}
      </div>
      {deliveries.map((d) => <HistoryRow key={d.id} d={d} />)}
    </div>
  );
}

function HistoryRow({ d }: { d: HistoryDelivery }) {
  const fetcher = useFetcher<{ image?: string; kind?: string; error?: string }>();
  const loading = fetcher.state !== "idle";
  const loadProof = () => fetcher.load(`/app/deliveries/${d.id}/proof`);

  return (
    <div style={{ borderBottom: "1px solid #f9fafb", background: "white" }}>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto auto",
        alignItems: "center", padding: "13px 16px",
      }}>
        <div>
          <span style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>{d.orderNumber}</span>
          <span style={{ fontSize: "12px", color: "#9ca3af", marginLeft: "8px" }}>{d.timeAgo}</span>
        </div>
        <div style={{ fontSize: "13px", color: "#374151" }}>{d.customerName}</div>
        <div style={{ fontSize: "13px", color: "#6b7280" }}>{d.customerAddress}, {d.customerComuna}</div>
        <div style={{ paddingRight: "16px" }}>
          <StatusDot status={d.status} />
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", justifyContent: "flex-end" }}>
          {d.status === "delivered" && (
            <button
              onClick={loadProof}
              disabled={loading}
              style={{
                fontSize: "12px", color: "#4B2BE0", fontWeight: "600",
                background: "none", border: "none", cursor: loading ? "default" : "pointer",
                padding: 0, whiteSpace: "nowrap", ...T,
              }}
            >
              {loading ? "Cargando..." : "Ver foto de entrega"}
            </button>
          )}
          {d.uberTrackingUrl && (
            <a
              href={d.uberTrackingUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: "12px", color: "#4B2BE0", fontWeight: "600", textDecoration: "none", whiteSpace: "nowrap" }}
            >
              Ver tracking
            </a>
          )}
        </div>
      </div>

      {/* Prueba de entrega cargada on-demand */}
      {fetcher.data?.image && (
        <div style={{ padding: "0 16px 14px" }}>
          <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "6px" }}>
            {fetcher.data.kind === "signature" ? "Firma de recepción" : "Foto de entrega"} · Uber Direct
          </div>
          <img
            src={fetcher.data.image}
            alt="Prueba de entrega"
            style={{ maxWidth: "280px", width: "100%", borderRadius: "10px", border: "1px solid #e5e7eb", display: "block" }}
          />
        </div>
      )}
      {fetcher.data?.error && (
        <div style={{ padding: "0 16px 14px", fontSize: "12px", color: "#9ca3af" }}>
          {fetcher.data.error}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    pending:         { label: "Esperando retiro", color: "#EF9F27" },
    pickup:          { label: "Courier en camino", color: "#3B82F6" },
    pickup_complete: { label: "Paquete recogido",  color: "#3B82F6" },
    dropoff:         { label: "En entrega",        color: "#4B2BE0" },
    delivered:       { label: "Entregado",         color: "#1D9E75" },
    canceled:        { label: "Cancelado",         color: "#DC2626" },
    returned:        { label: "Devuelto",          color: "#DC2626" },
  };
  const s = map[status] ?? { label: status, color: "#9ca3af" };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", ...T }}>
      <span style={{
        width: "6px", height: "6px", borderRadius: "50%",
        background: s.color, display: "inline-block", flexShrink: 0,
      }} />
      <span style={{ fontSize: "12px", color: "#374151", fontWeight: "500" }}>{s.label}</span>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
