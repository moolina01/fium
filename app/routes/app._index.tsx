import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { authenticate, registerCarrierService } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { getDelivery, cancelDelivery, getStoreUberCreds, type UberCreds } from "../services/uber-direct.server";
import { getSetupChecklist, type SetupChecklist } from "../lib/setup.server";
import { saveUberCredentials } from "../lib/uber-credentials.server";
import { logError } from "../lib/logger.server";
import { applyUberStatus } from "../lib/delivery-status.server";
import { Bike, Car, Check, ChevronRight, Motorbike, Phone } from "lucide-react";
import { FONT } from "../lib/theme";
import { CountUp } from "../components/CountUp";
import { describePlacedAt, dispatchPromise, hoursFromConfig, isSameDayDispatch, minutesWaiting, relativeDayLabel } from "../lib/dispatch-hours";
import { UberConnectCard } from "../components/setup/UberConnectCard";
import { ShopifyActivationCard } from "../components/setup/ShopifyActivationCard";

type Order = {
  id: string;
  name: string;
  timeAgo: string;
  minutesAgo: number;     // Minutos esperando desde que se pudo despachar (negativo si aún no abre el horario)
  // Comprado fuera del horario de despacho (de noche, domingo…). startsLabel solo
  // viene si todavía no abre el horario: "Sale mañana desde las 09:00".
  outOfHours: boolean;
  startsLabel: string | null;
  orderId: string;
  customerName: string;
  address: string;
  city: string;
  autoDispatchFailed: boolean;
  // true si Uber canceló un envío ya creado; false si nunca se pudo crear.
  failedAfterDispatch: boolean;
  failureReason: string | null;
};

// Envío que Uber devolvió a la tienda y que la tienda aún no marcó como visto.
type ReturnedAlert = {
  id: string;
  orderNumber: string;
  customerName: string;
  reason: string | null;
  timeAgo: string;
};

type DismissedOrderRow = {
  orderId: string; // GID
  orderNumber: string;
  customerName: string;
  timeAgo: string; // cuándo se marcó como "No gestionar"
};

type DeliveryBase = {
  id: string;
  orderNumber: string;
  customerName: string;
  customerAddress: string;
  customerComuna: string;
  status: string;
  uberTrackingUrl: string | null;
  timeAgo: string;
};

// En curso: además, ETA y conductor guardados del último sync con Uber.
type ActiveDelivery = DeliveryBase & {
  pickupEta: string | null;  // ISO
  dropoffEta: string | null; // ISO
  courierName: string | null;
  courierPhone: string | null;
  courierVehicle: string | null;
};

type HistoryDelivery = DeliveryBase & {
  isDeliveredToday: boolean;
  finishedAt: string; // ISO — última actualización, que para un envío terminado es cuándo terminó
};

function calcMinutesAgo(dateStr: string) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

function calcTimeAgo(dateStr: string) {
  const mins = calcMinutesAgo(dateStr);
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  return `hace ${Math.floor(hrs / 24)}d`;
}

// Fium Express promete entrega en 2 a 3 horas desde el pago, y el viaje de Uber
// toma cerca de una hora. Si un pedido lleva 15+ min sin despacharse ya le está
// comiendo margen a esa promesa; sobre 30 min conviene despacharlo de inmediato.
function pendingUrgency(minutesAgo: number): { color: string; textColor: string } | null {
  if (minutesAgo >= 30) return { color: "#DC2626", textColor: "#DC2626" };
  if (minutesAgo >= 15) return { color: "#EF9F27", textColor: "#B45309" };
  return null;
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
              shippingLines(first: 1) { edges { node { title code } } }
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

  let deliveries = await db.delivery.findMany({ where: { shop: session.shop } });

  // Sync con Uber (estado, ETA y conductor) como respaldo de los webhooks. El
  // panel se recarga cada 30 s mientras hay envíos en curso, pero cada envío se
  // consulta a Uber como mucho una vez cada 30 s EN TOTAL — no por pestaña ni por
  // usuario —, así las llamadas a Uber dependen solo de cuántos envíos hay en curso.
  const SYNC_EVERY_MS = 30 * 1000;
  // Credenciales de Uber de la tienda — si aún no conectó su cuenta, no sincronizamos.
  let uberCreds: UberCreds | null = null;
  try {
    uberCreds = await getStoreUberCreds(session.shop);
  } catch {
    uberCreds = null;
  }
  const cutoff = new Date(Date.now() - SYNC_EVERY_MS);
  const due = (uberCreds ? deliveries : [])
    .filter(
      (d) =>
        !["delivered", "canceled", "returned", "failed"].includes(d.status) &&
        d.uberDeliveryId &&
        (!d.liveSyncedAt || d.liveSyncedAt < cutoff)
    )
    .slice(0, 15);
  const synced = await Promise.allSettled(
    due.map(async (d) => {
      // Reservar el turno de forma atómica: si otra pestaña/usuario ya lo consultó
      // en los últimos 30 s, count = 0 y no llamamos a Uber.
      const claimed = await db.delivery.updateMany({
        where: { id: d.id, OR: [{ liveSyncedAt: null }, { liveSyncedAt: { lt: cutoff } }] },
        data: { liveSyncedAt: new Date() },
      });
      if (claimed.count === 0) return;
      try {
        const live = await getDelivery(uberCreds!, d.uberDeliveryId!);
        await applyUberStatus(d, live, "dashboard/sync-delivery");
      } catch (err) {
        // Mantener lo guardado si Uber no responde — no rompe el dashboard
        logError("dashboard/sync-delivery", err, { deliveryId: d.id });
      }
    })
  );
  if (synced.length > 0) {
    deliveries = await db.delivery.findMany({ where: { shop: session.shop } });
  }

  // Pedidos que la tienda marcó como "No gestionar": no aparecen en "Por despachar"
  // ni cuentan como problema.
  const dismissed = await db.dismissedOrder.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  const dismissedOrderIds = new Set(dismissed.map((d) => d.orderId));

  // failed se excluye: la orden debe reaparecer en "Por despachar" para despacho manual
  const deliveredOrderIds = new Set(
    deliveries.filter((d: any) => d.status !== "failed").map((d: any) => d.orderId)
  );
  const failedOrderIds = new Set(
    deliveries.filter((d: any) => d.status === "failed").map((d: any) => d.orderId)
  );
  // Motivo real que devolvió Uber Direct para cada orden que falló en el auto-despacho.
  const failedAfterDispatchIds = new Set(
    deliveries.filter((d: any) => d.status === "failed" && d.uberDeliveryId).map((d: any) => d.orderId)
  );
  const failureReasonByOrderId = new Map(
    deliveries
      .filter((d: any) => d.status === "failed")
      .map((d: any) => [d.orderId, d.failureReason as string | null])
  );
  const todayStr = new Date().toDateString();

  // Órdenes Shopify sin delivery creado aún (+ las que fallaron en auto-dispatch).
  // Más nuevas primero; las que llevan rato esperando se marcan con el punto de urgencia.
  const hours = hoursFromConfig(config);
  const now = new Date();
  const pendingOrders: Order[] = raw
    .filter((e: any) =>
      e.node.shippingLines.edges.some((s: any) => {
        // Se reconoce por el service_code de carrier.rates; el título queda de respaldo.
        const title = s.node.title.toLowerCase();
        return (s.node.code === "uber_direct" || title.includes("uber") || title.includes("fium")) &&
          !deliveredOrderIds.has(e.node.id) && !dismissedOrderIds.has(e.node.id);
      })
    )
    .sort(
      (a: { node: { createdAt: string } }, b: { node: { createdAt: string } }) =>
        new Date(b.node.createdAt).getTime() - new Date(a.node.createdAt).getTime()
    )
    .map((e: any) => {
      const placedAt = new Date(e.node.createdAt);
      const outOfHours = !isSameDayDispatch(placedAt, hours);
      const promise = dispatchPromise(placedAt, hours);
      const startTime = promise.startsAt.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: "America/Santiago" });
      return {
      id: e.node.id,
      name: e.node.name,
      timeAgo: outOfHours ? describePlacedAt(placedAt, now) : calcTimeAgo(e.node.createdAt),
      minutesAgo: minutesWaiting(placedAt, hours, now),
      outOfHours,
      startsLabel: promise.startsAt > now ? `Sale ${relativeDayLabel(promise.startsAt, now)} desde las ${startTime}` : null,
      orderId: (e.node.id as string).split("/").pop() ?? "",
      customerName: e.node.shippingAddress?.name ?? "Sin nombre",
      address: e.node.shippingAddress?.address1 ?? "",
      city: e.node.shippingAddress?.city ?? "",
      autoDispatchFailed: failedOrderIds.has(e.node.id),
      failedAfterDispatch: failedAfterDispatchIds.has(e.node.id),
      failureReason: failureReasonByOrderId.get(e.node.id) ?? null,
      };
    });

  // Solo los no gestionados que siguen abiertos en Shopify (últimos 30 días), para
  // poder volver a gestionarlos; los ya preparados o cerrados no hace falta mostrarlos.
  const openOrderIds = new Set(raw.map((e: any) => e.node.id as string));
  const dismissedOrders: DismissedOrderRow[] = dismissed
    .filter((d) => openOrderIds.has(d.orderId))
    .map((d) => ({
      orderId: d.orderId,
      orderNumber: d.orderNumber,
      customerName: d.customerName,
      timeAgo: calcTimeAgo(d.createdAt.toString()),
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
      pickupEta: d.pickupEta?.toISOString() ?? null,
      dropoffEta: d.dropoffEta?.toISOString() ?? null,
      courierName: d.courierName ?? null,
      courierPhone: d.courierPhone ?? null,
      courierVehicle: d.courierVehicle ?? null,
    }));

  const returnedAlerts: ReturnedAlert[] = deliveries
    .filter((d: any) => d.status === "returned" && !d.attentionAckAt)
    .sort((a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((d: any) => ({
      id: d.id,
      orderNumber: d.orderNumber,
      customerName: d.customerName,
      reason: d.failureReason ?? null,
      timeAgo: calcTimeAgo(d.updatedAt.toString()),
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
      isDeliveredToday: d.status === "delivered" && new Date(d.createdAt).toDateString() === todayStr,
      finishedAt: d.updatedAt.toISOString(),
    }));

  return {
    hasConfig: true,
    pendingOrders,
    dismissedOrders,
    returnedAlerts,
    activeDeliveries,
    history,
    active: deliveries.filter((d: any) =>
      ["pending", "pickup", "pickup_complete", "dropoff"].includes(d.status)
    ).length,
    delivered: deliveries.filter(
      (d: any) => d.status === "delivered" && new Date(d.createdAt).toDateString() === todayStr
    ).length,
    issues: deliveries.filter((d: any) => d.status === "failed" && !dismissedOrderIds.has(d.orderId)).length,
    setup,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "ack_shopify_activation") {
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { carrierActivatedAck: true, phoneRequiredAck: true },
    });
    return { ok: true };
  }

  if (intent === "uber_credentials") {
    const result = await saveUberCredentials(session.shop, {
      uberClientId: (formData.get("uberClientId") as string) || "",
      uberCustomerId: (formData.get("uberCustomerId") as string) || "",
      uberClientSecret: (formData.get("uberClientSecret") as string) || "",
    });
    return "error" in result ? { error: result.error } : { ok: true };
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

  if (intent === "ack_returned") {
    const deliveryId = (formData.get("deliveryId") as string) || "";
    await db.delivery.updateMany({
      where: { id: deliveryId, shop: session.shop, status: "returned" },
      data: { attentionAckAt: new Date() },
    });
    return { ok: true };
  }

  if (intent === "dismiss_order" || intent === "restore_order") {
    const orderId = (formData.get("orderId") as string) || "";
    if (!orderId.startsWith("gid://shopify/Order/")) return { error: "Pedido inválido." };
    if (intent === "restore_order") {
      await db.dismissedOrder.deleteMany({ where: { shop: session.shop, orderId } });
      return { ok: true };
    }
    // Un pedido con un envío vivo en Uber no se puede soltar: primero hay que cancelarlo.
    const live = await db.delivery.findFirst({
      where: { shop: session.shop, orderId, status: { notIn: ["failed", "canceled"] } },
    });
    if (live) return { error: "Este pedido ya tiene un envío con Uber. Cancélalo primero desde \"En curso\"." };
    const data = {
      orderNumber: ((formData.get("orderNumber") as string) || "").slice(0, 50),
      customerName: ((formData.get("customerName") as string) || "").slice(0, 200),
    };
    await db.dismissedOrder.upsert({
      where: { shop_orderId: { shop: session.shop, orderId } },
      create: { shop: session.shop, orderId, ...data },
      update: data,
    });
    return { ok: true };
  }

  if (intent === "cancel_delivery") {
    const deliveryId = formData.get("deliveryId") as string;
    const delivery = await db.delivery.findFirst({ where: { id: deliveryId, shop: session.shop } });
    if (!delivery?.uberDeliveryId) return { error: "Envío no encontrado." };
    try {
      // Se marca "canceled" ANTES de llamar a Uber: así el webhook de cancelación
      // que manda Uber no se confunde con una cancelación de Uber (sin courier).
      await db.delivery.update({ where: { id: deliveryId }, data: { status: "canceled" } });
      try {
        const creds = await getStoreUberCreds(session.shop);
        await cancelDelivery(creds, delivery.uberDeliveryId);
      } catch (e) {
        await db.delivery.update({ where: { id: deliveryId }, data: { status: delivery.status } });
        throw e;
      }
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

// ─── Movimiento del dashboard ───────────────────────────────────────────────
// Mismo lenguaje de animación que el onboarding (fade-up + pulse), para que el
// panel principal no se sienta estático comparado con el resto de la app.
const GLOBAL_CSS = `
@keyframes fuFadeUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fuPulse {
  0%   { box-shadow: 0 0 0 0 rgba(29,158,117,0.5); }
  70%  { box-shadow: 0 0 0 6px rgba(29,158,117,0); }
  100% { box-shadow: 0 0 0 0 rgba(29,158,117,0); }
}
.fu-row { transition: background 0.15s ease; }
.fu-row:hover { background: #fafafb; }
.fu-btn { transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease; }
.fu-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
.fu-tab:hover { color: #4B2BE0; }
.fu-ghost-btn {
  padding: 6px 10px; border: none; background: transparent; border-radius: 6px;
  font-size: 12px; font-weight: 600; color: #6b7280; cursor: pointer; white-space: nowrap;
  font-family: inherit; transition: background 0.15s ease, color 0.15s ease;
}
.fu-ghost-btn:hover { background: #f3f4f6; color: #111827; }
.fu-ghost-btn.fu-ghost-brand { color: #4B2BE0; }
.fu-ghost-btn.fu-ghost-brand:hover { background: #EEEDFE; color: #4B2BE0; }
@keyframes fuModalIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes fuOverlayIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes fuPulseRed {
  0%   { box-shadow: 0 0 0 0 rgba(220,38,38,0.5); }
  70%  { box-shadow: 0 0 0 6px rgba(220,38,38,0); }
  100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
}
.fu-tile { cursor: pointer; transition: background 0.15s ease; text-align: left; border: none; }
.fu-tile:hover { background: #fafafb; }
@keyframes fuJustDispatched {
  0%   { background: #EEEDFE; box-shadow: inset 3px 0 0 #4B2BE0; }
  70%  { background: #EEEDFE; box-shadow: inset 3px 0 0 #4B2BE0; }
  100% { background: #FFFFFF; box-shadow: inset 3px 0 0 transparent; }
}
@keyframes fuBadgePop {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.35); }
  100% { transform: scale(1); }
}
.fu-just-dispatched { animation: fuJustDispatched 2.8s ease-out 0.25s both; }
.fu-badge-pop { animation: fuBadgePop 0.45s cubic-bezier(0.22,1,0.36,1) both; }
/* Barra de progreso: los pasos hechos se llenan una vez; el actual "carga" en bucle. */
@keyframes fuStepFill {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}
@keyframes fuStepLoading {
  0%   { transform: scaleX(0); opacity: 1; }
  75%  { transform: scaleX(1); opacity: 1; }
  100% { transform: scaleX(1); opacity: 0; }
}
.fu-step-fill { transform-origin: left center; animation: fuStepFill 0.5s cubic-bezier(0.22,1,0.36,1) both; }
.fu-step-loading { transform-origin: left center; animation: fuStepLoading 2.2s cubic-bezier(0.45,0,0.25,1) infinite both; }
/* Envío recién entregado: la tarjeta se despide y la fila del historial destella en verde. */
@keyframes fuDeliveredOut {
  0%   { opacity: 1; transform: translateY(0) scale(1); }
  100% { opacity: 0; transform: translateY(-6px) scale(0.98); }
}
@keyframes fuJustDelivered {
  0%   { background: #E6F7F2; box-shadow: inset 3px 0 0 #1D9E75; }
  70%  { background: #E6F7F2; box-shadow: inset 3px 0 0 #1D9E75; }
  100% { background: #FFFFFF; box-shadow: inset 3px 0 0 transparent; }
}
.fu-delivered-out { animation: fuDeliveredOut 0.35s ease-in 1.35s both; }
.fu-just-delivered { animation: fuJustDelivered 2.8s ease-out 0.2s both; }
.fu-history-row { cursor: pointer; transition: background 0.15s ease; }
.fu-history-row:hover { background: #fafafb; }
.fu-history-row:hover .fu-chevron { transform: translateX(2px); color: #4B2BE0; }
.fu-chevron { transition: transform 0.15s ease, color 0.15s ease; }
@media (prefers-reduced-motion: reduce) {
  .fu-just-dispatched, .fu-badge-pop, .fu-step-fill, .fu-delivered-out, .fu-just-delivered { animation: none; }
  .fu-step-loading { animation: none; transform: scaleX(0.6); }
}
`;

function fu(delay = 0, duration = 380): React.CSSProperties {
  return { animation: `fuFadeUp ${duration}ms ${delay}ms cubic-bezier(0.22,1,0.36,1) both` };
}

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const [tab, setTab] = useState<"pending" | "confirmed" | "history">("pending");
  // Recién despachado desde el detalle de la orden (?despachado=<id>): se muestra
  // un instante "Por despachar" y luego se salta a "En curso" con la fila resaltada.
  const [searchParams] = useSearchParams();
  const [justDispatchedId, setJustDispatchedId] = useState<string | null>(searchParams.get("despachado"));
  // Filtros que se activan al hacer clic en un tile de métricas, para saltar
  // directo a "esos" pedidos en vez de tener que buscarlos a mano en la tabla.
  const [pendingFilter, setPendingFilter] = useState<"all" | "problems">("all");
  const [historyFilter, setHistoryFilter] = useState<"all" | "today">("all");
  const { pendingOrders, dismissedOrders, returnedAlerts, activeDeliveries, history, active, delivered, issues, setup } = data;

  // "No gestionar": se pide confirmación y la fila se oculta al tiro (optimista)
  // mientras el servidor lo guarda.
  const [confirmDismiss, setConfirmDismiss] = useState<Order | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const dismissFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const restoreFetcher = useFetcher<{ ok?: boolean; error?: string }>();
  function dismissOrder(order: Order) {
    setConfirmDismiss(null);
    setHiddenIds((prev) => new Set(prev).add(order.id));
    dismissFetcher.submit(
      { intent: "dismiss_order", orderId: order.id, orderNumber: order.name, customerName: order.customerName },
      { method: "post" }
    );
    showToast(`Pedido ${order.name} ya no se gestiona con Fium`, {
      action: "Deshacer",
      onAction: () => restoreOrder(order.id),
    });
  }
  function restoreOrder(orderId: string) {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(orderId);
      return next;
    });
    restoreFetcher.submit({ intent: "restore_order", orderId }, { method: "post" });
  }
  useEffect(() => {
    if (dismissFetcher.state !== "idle" || !dismissFetcher.data?.error) return;
    // Falló en el servidor: la fila vuelve a aparecer.
    setHiddenIds(new Set());
    showToast(dismissFetcher.data.error, { isError: true });
  }, [dismissFetcher.state, dismissFetcher.data]);

  const managedPendingOrders = pendingOrders.filter((o) => !hiddenIds.has(o.id));
  const visiblePendingOrders = pendingFilter === "problems"
    ? managedPendingOrders.filter((o) => o.autoDispatchFailed)
    : managedPendingOrders;
  const visibleHistory = historyFilter === "today"
    ? history.filter((d) => d.isDeliveredToday)
    : history;

  useEffect(() => {
    if (!justDispatchedId) return;
    const dispatched = data.activeDeliveries.find((d) => d.id === justDispatchedId);
    // Quitar el parámetro sin recargar (evita que se repita al refrescar y no
    // vuelve a correr el loader, que consulta a Uber).
    const url = new URL(window.location.href);
    url.searchParams.delete("despachado");
    window.history.replaceState(window.history.state, "", url.toString());

    const toTab = setTimeout(() => {
      setTab("confirmed");
      if (dispatched) {
        (window as { shopify?: { toast?: { show: (m: string) => void } } }).shopify?.toast?.show(
          `Envío ${dispatched.orderNumber} creado`
        );
      }
    }, 450);
    const clear = setTimeout(() => setJustDispatchedId(null), 3600);
    return () => { clearTimeout(toTab); clearTimeout(clear); };
    // Solo al llegar con el parámetro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Envío que acaba de pasar a "Entregado" mientras se miraba "En curso": se
  // muestra un instante completo y en verde, y luego se pasa al historial.
  const [deliveredGhost, setDeliveredGhost] = useState<ActiveDelivery | null>(null);
  const [justDeliveredId, setJustDeliveredId] = useState<string | null>(null);
  const prevActive = useRef<ActiveDelivery[]>(activeDeliveries);
  const deliveredTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    const before = prevActive.current;
    prevActive.current = activeDeliveries;
    const stillActive = new Set(activeDeliveries.map((d) => d.id));
    const returned = before.find(
      (d) => !stillActive.has(d.id) && history.some((h) => h.id === d.id && h.status === "returned")
    );
    if (returned) showToast(`Pedido ${returned.orderNumber} devuelto a tu tienda`, { isError: true });
    const delivered = before.find(
      (d) => !stillActive.has(d.id) && history.some((h) => h.id === d.id && h.status === "delivered")
    );
    if (!delivered) return;

    const toast = (window as { shopify?: { toast?: { show: (m: string) => void } } }).shopify?.toast;
    if (tabRef.current !== "confirmed") {
      toast?.show(`Pedido ${delivered.orderNumber} entregado`);
      setJustDeliveredId(delivered.id);
      return;
    }
    setDeliveredGhost({ ...delivered, status: "delivered" });
    // Timers fuera del ciclo del efecto: si los datos se recargan durante la
    // animación, igual debe terminar (si no, la tarjeta verde quedaría pegada).
    deliveredTimers.current.push(
      setTimeout(() => {
        setDeliveredGhost(null);
        setTab("history");
        setHistoryFilter("all");
        setJustDeliveredId(delivered.id);
        toast?.show(`Pedido ${delivered.orderNumber} entregado`);
      }, 1750),
      setTimeout(() => setJustDeliveredId(null), 1750 + 3200),
    );
  }, [activeDeliveries, history]);
  useEffect(() => () => deliveredTimers.current.forEach(clearTimeout), []);

  // Mientras haya envíos en curso, recargar los datos cada 30 s para que el
  // estado avance solo (el loader consulta a Uber los envíos desactualizados).
  // Se pausa con la pestaña oculta para no gastar llamadas a Uber.
  const revalidator = useRevalidator();
  const hasActive = activeDeliveries.length > 0;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, 30_000);
    return () => clearInterval(id);
  }, [hasActive, revalidator]);

  function goToTab(key: "pending" | "confirmed" | "history") {
    setTab(key);
    if (key === "pending") setPendingFilter("all");
    if (key === "history") setHistoryFilter("all");
  }

  return (
    <s-page heading="Envíos">
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
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
              animation: "fuPulse 2s ease-out infinite",
            }} />
            <span style={{ fontSize: "12px", color: "#374151", fontWeight: "500" }}>Uber Direct activo</span>
          </div>
        </div>
      </s-section>

      {returnedAlerts.length > 0 && (
        <s-section>
          <ReturnedAlerts alerts={returnedAlerts} />
        </s-section>
      )}

      {/* Métricas */}
      <s-section>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
          borderRadius: "10px", border: "1px solid #e5e7eb",
          overflow: "hidden", ...T,
        }}>
          {([
            { value: active,    label: "En curso",       color: "#4B2BE0", onClick: () => goToTab("confirmed") },
            { value: delivered, label: "Entregadas hoy", color: "#1D9E75", onClick: () => { setTab("history"); setHistoryFilter("today"); } },
            { value: issues,    label: "Con problemas",  color: "#DC2626", onClick: () => { setTab("pending"); setPendingFilter("problems"); } },
          ] as const).map(({ value, label, color, onClick }, i) => (
            <button
              key={label}
              className="fu-tile"
              onClick={onClick}
              title={`Ver ${label.toLowerCase()}`}
              style={{
                padding: "20px 24px",
                borderRight: i < 2 ? "1px solid #e5e7eb" : "none",
                background: "white",
                ...fu(i * 60),
              }}
            >
              <div style={{ fontSize: "28px", fontWeight: "700", color, letterSpacing: "-1px", lineHeight: 1 }}>
                <CountUp end={value} delay={100 + i * 60} />
              </div>
              <div style={{ fontSize: "13px", color: "#6b7280", marginTop: "4px" }}>
                {label}
              </div>
            </button>
          ))}
        </div>
      </s-section>

      {/* Tabla */}
      <s-section>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb", marginBottom: "0", ...T }}>
          {([
            { key: "pending",   label: "Por despachar", count: managedPendingOrders.length },
            { key: "confirmed", label: "En curso",      count: activeDeliveries.length },
            { key: "history",   label: "Historial",     count: history.length },
          ] as const).map(({ key, label, count }) => (
            <button
              key={key}
              className="fu-tab"
              onClick={() => goToTab(key)}
              style={{
                padding: "10px 16px", border: "none", background: "transparent",
                fontSize: "13px", fontWeight: "600", cursor: "pointer", ...T,
                color: tab === key ? "#111827" : "#9ca3af",
                borderBottom: tab === key ? "2px solid #4B2BE0" : "2px solid transparent",
                marginBottom: "-1px", display: "flex", alignItems: "center", gap: "6px",
                transition: "color 0.15s ease, border-color 0.15s ease",
              }}
            >
              {label}
              <span className={key === "confirmed" && justDispatchedId && tab === "confirmed" ? "fu-badge-pop" : undefined} style={{
                display: "inline-block",
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

        <div key={`${tab}-${pendingFilter}-${historyFilter}`} style={fu(0, 220)}>
          {tab === "pending" && (
            <>
              {pendingFilter === "problems" && (
                <FilterBanner
                  text="Mostrando solo pedidos con problemas de auto-despacho"
                  onClear={() => setPendingFilter("all")}
                />
              )}
              {visiblePendingOrders.length === 0
                ? <EmptyState
                    title={pendingFilter === "problems" ? "No hay pedidos con problemas" : "Aún no hay pedidos por despachar"}
                    text={pendingFilter === "problems"
                      ? "Ningún pedido está fallando el auto-despacho en este momento."
                      : "Cuando un cliente elija Fium en el checkout, su pedido aparecerá aquí listo para despachar con un clic."}
                  />
                : <OrderTable orders={visiblePendingOrders} onDismiss={setConfirmDismiss} />}
              {pendingFilter === "all" && (
                <DismissedList orders={dismissedOrders} onRestore={restoreOrder} />
              )}
            </>
          )}
          {tab === "confirmed" && (
            activeDeliveries.length === 0 && !deliveredGhost
              ? <EmptyState
                  title="No hay envíos en curso"
                  text="Los envíos que despaches aparecerán aquí con su estado en tiempo real, desde que el courier los retira hasta la entrega."
                />
              : <DeliveryTable
                  deliveries={deliveredGhost ? [deliveredGhost, ...activeDeliveries] : activeDeliveries}
                  highlightId={justDispatchedId}
                  leavingId={deliveredGhost?.id}
                />
          )}
          {tab === "history" && (
            <>
              {historyFilter === "today" && (
                <FilterBanner
                  text="Mostrando solo lo entregado hoy"
                  onClear={() => setHistoryFilter("all")}
                />
              )}
              {visibleHistory.length === 0
                ? <EmptyState
                    title={historyFilter === "today" ? "Aún no has entregado nada hoy" : "Aún no hay envíos completados"}
                    text={historyFilter === "today"
                      ? "Los pedidos entregados hoy van a aparecer aquí."
                      : "Aquí verás el historial de tus entregas, cancelaciones y devoluciones."}
                  />
                : <HistoryTable deliveries={visibleHistory} highlightId={justDeliveredId} />}
            </>
          )}
        </div>
      </s-section>

      {confirmDismiss && (
        <ConfirmDismissModal
          order={confirmDismiss}
          onCancel={() => setConfirmDismiss(null)}
          onConfirm={() => dismissOrder(confirmDismiss)}
        />
      )}
    </s-page>
  );
}

type ToastOptions = { action?: string; onAction?: () => void; isError?: boolean; duration?: number };
function showToast(message: string, options?: ToastOptions) {
  (window as { shopify?: { toast?: { show: (m: string, o?: ToastOptions) => void } } })
    .shopify?.toast?.show(message, options);
}

function FilterBanner({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      background: "#EEEDFE", borderBottom: "1px solid #e5e7eb",
      padding: "9px 16px", fontSize: "12px", color: "#4B2BE0", fontWeight: "600", ...T,
    }}>
      <span>{text}</span>
      <button
        onClick={onClear}
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: "#4B2BE0", fontSize: "12px", fontWeight: "600",
          textDecoration: "underline", padding: 0, ...T,
        }}
      >
        Ver todos
      </button>
    </div>
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
  const uberFetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const shopifyFetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const registerFetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const uberStep = setup.steps.find((s) => s.key === "uber")!;
  const shopifyStep = setup.steps.find((s) => s.key === "shopifyActivation")!;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", ...T }}>
      <div style={{
        background: "white", border: "2px solid #4B2BE0", borderRadius: "12px",
        overflow: "hidden",
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

        {/* Confirmación en vivo — Shopify ya pide tarifas de Fium en el checkout */}
        {shopifyStep.done && setup.carrierLiveAt && (
          <div style={{ padding: "0 20px 18px" }}>
            <div style={{
              background: "#E6F7F2", border: "1px solid #A7E6C8", borderRadius: "8px",
              padding: "10px 14px", fontSize: "12px", color: "#0F7355", lineHeight: "1.6",
            }}>
              ✅ <strong>Activo en tu checkout.</strong> Shopify pidió cotizaciones de Fium {calcTimeAgo(setup.carrierLiveAt)}.
            </div>
          </div>
        )}
      </div>

      {/* Cards accionables — mismos componentes que usa el onboarding, así que
          continuar la configuración acá se ve idéntico a como quedó pendiente. */}
      {!uberStep.done && <UberConnectCard fetcher={uberFetcher} variant="banner" />}
      {!shopifyStep.done && (
        <ShopifyActivationCard
          fetcher={shopifyFetcher}
          registerFetcher={registerFetcher}
          variant="banner"
          carrierRegistered={setup.carrierRegistered}
          carrierActivatedAck={setup.carrierActivatedAck}
          phoneRequiredAck={setup.phoneRequiredAck}
          carrierLiveAt={setup.carrierLiveAt}
        />
      )}
    </div>
  );
}

// Columna de acciones de ancho fijo: así "Reintentar envío" (más corto) no corre
// las demás columnas.
const ORDER_COLUMNS = "1fr 1fr 1fr 250px";

function OrderTable({ orders, onDismiss }: { orders: Order[]; onDismiss: (order: Order) => void }) {
  return (
    <div style={{ ...T }}>
      <div style={{
        display: "grid", gridTemplateColumns: ORDER_COLUMNS,
        padding: "8px 16px", borderBottom: "1px solid #f3f4f6",
      }}>
        {["Orden", "Cliente", "Dirección", ""].map((h) => (
          <div key={h} style={{ fontSize: "11px", fontWeight: "600", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {h}
          </div>
        ))}
      </div>
      {orders.map((order, i) => {
        const urgency = pendingUrgency(order.minutesAgo);
        return (
        <div key={order.id} className="fu-row" style={{
          borderBottom: "1px solid #f9fafb", background: "white",
          ...fu(Math.min(i, 8) * 35),
        }}>
          <div style={{
            display: "grid", gridTemplateColumns: ORDER_COLUMNS,
            alignItems: "center", padding: "13px 16px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              {urgency && (
                <span
                  title={order.minutesAgo >= 30 ? "Lleva más de 30 min sin despacharse" : "Lleva más de 15 min sin despacharse"}
                  style={{ width: "7px", height: "7px", borderRadius: "50%", background: urgency.color, flexShrink: 0 }}
                />
              )}
              <span style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>{order.name}</span>
              <span style={{ fontSize: "12px", color: urgency?.textColor ?? "#9ca3af", fontWeight: urgency ? "700" : "400" }}>{order.timeAgo}</span>
              {order.outOfHours && (
                <span
                  title={order.startsLabel ?? "Se compró fuera de tu horario de despacho. Al cliente se le prometió para el siguiente día de despacho."}
                  style={{
                    fontSize: "11px", fontWeight: 600, color: "#4B2BE0", background: "#EEEDFE",
                    borderRadius: "99px", padding: "2px 8px", whiteSpace: "nowrap",
                  }}
                >
                  {order.startsLabel ?? "Fuera de horario"}
                </span>
              )}
            </div>
            <div style={{ fontSize: "13px", color: "#374151" }}>{order.customerName}</div>
            <div style={{ fontSize: "13px", color: "#6b7280" }}>{order.address}, {order.city}</div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px" }}>
              <button
                type="button"
                className="fu-ghost-btn"
                onClick={() => onDismiss(order)}
                title="Fium deja de gestionar este pedido"
              >
                No gestionar
              </button>
              <Link
                to={`/app/orders/${order.orderId}`}
                className="fu-btn"
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
              {order.failedAfterDispatch
                ? order.failureReason ?? "Uber Direct canceló el envío. Vuelve a despacharlo."
                : <>
                    {order.failureReason
                      ? `El auto-despacho falló: ${order.failureReason}`
                      : "El auto-despacho falló al contactar Uber Direct."}{" "}
                    Despacha manualmente.
                  </>}
            </div>
          )}
        </div>
        );
      })}
    </div>
  );
}

function ReturnedAlerts({ alerts }: { alerts: ReturnedAlert[] }) {
  const fetcher = useFetcher();
  // Se oculta al tiro al apretar "Entendido", sin esperar la recarga.
  const ackingId = fetcher.state !== "idle" ? (fetcher.formData?.get("deliveryId") as string) : null;
  const visible = alerts.filter((a) => a.id !== ackingId);
  if (visible.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", ...T }}>
      {visible.map((a, i) => (
        <div key={a.id} role="alert" style={{
          display: "flex", alignItems: "flex-start", gap: "12px", flexWrap: "wrap",
          background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "10px",
          padding: "14px 16px", ...fu(i * 60),
        }}>
          <span aria-hidden="true" style={{
            width: "8px", height: "8px", borderRadius: "50%", background: "#DC2626",
            marginTop: "6px", flexShrink: 0, animation: "fuPulseRed 2s ease-out infinite",
          }} />
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#7F1D1D" }}>
              Pedido {a.orderNumber} devuelto a tu tienda
              <span style={{ fontSize: "12px", fontWeight: 500, color: "#B91C1C", marginLeft: "8px" }}>{a.timeAgo}</span>
            </div>
            <div style={{ fontSize: "13px", color: "#7F1D1D", marginTop: "3px", lineHeight: 1.5 }}>
              {a.reason ?? "El conductor no pudo entregar el pedido y lo devolvió a tu tienda."}{" "}
              Coordina con {a.customerName} un nuevo envío o el reembolso desde Shopify.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}>
            <Link
              to={`/app/deliveries/${a.id}`}
              className="fu-ghost-btn"
              style={{ color: "#B91C1C", textDecoration: "none" }}
            >
              Ver detalle
            </Link>
            <button
              type="button"
              className="fu-btn"
              onClick={() => fetcher.submit({ intent: "ack_returned", deliveryId: a.id }, { method: "post" })}
              style={{
                padding: "6px 14px", border: "none", borderRadius: "6px", cursor: "pointer",
                background: "#DC2626", color: "white", fontSize: "12px", fontWeight: 600, fontFamily: "inherit",
              }}
            >
              Entendido
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ConfirmDismissModal({ order, onCancel, onConfirm }: { order: Order; onCancel: () => void; onConfirm: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", ...T,
    }}>
      <button
        type="button"
        aria-label="Cerrar"
        tabIndex={-1}
        onClick={onCancel}
        style={{
          position: "absolute", inset: 0, border: "none", padding: 0, cursor: "default",
          background: "rgba(17,24,39,0.45)", animation: "fuOverlayIn 0.15s ease-out both",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fu-dismiss-title"
        style={{
          position: "relative", width: "100%", maxWidth: "440px", background: "white", borderRadius: "12px",
          boxShadow: "0 20px 50px rgba(17,24,39,0.25)", overflow: "hidden",
          animation: "fuModalIn 0.2s cubic-bezier(0.22,1,0.36,1) both",
        }}
      >
        <div style={{ padding: "20px 22px 4px" }}>
          <div id="fu-dismiss-title" style={{ fontSize: "16px", fontWeight: 700, color: "#111827" }}>
            ¿Dejar de gestionar el pedido {order.name}?
          </div>
          <div style={{ fontSize: "13px", color: "#6b7280", marginTop: "4px" }}>
            {order.customerName}{order.address ? ` · ${order.address}, ${order.city}` : ""}
          </div>
        </div>
        <div style={{ padding: "12px 22px 0", fontSize: "13px", color: "#374151", lineHeight: 1.55 }}>
          Fium no va a despachar este pedido con Uber y saldrá de “Por despachar”. Úsalo si el pedido se canceló,
          lo vas a entregar de otra forma o tuvo algún problema.
        </div>
        <div style={{
          margin: "14px 22px 0", padding: "10px 12px", borderRadius: "8px",
          background: "#FFFBEB", border: "1px solid #FDE68A",
          fontSize: "12px", color: "#92400E", lineHeight: 1.5,
        }}>
          El cliente pagó el envío Fium en el checkout. Si no le vas a entregar el pedido, gestiona la entrega
          o el reembolso desde el pedido en Shopify.
        </div>
        <div style={{ fontSize: "12px", color: "#9ca3af", padding: "10px 22px 0" }}>
          Podrás volver a gestionarlo desde “Pedidos no gestionados”.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", padding: "18px 22px 20px" }}>
          <button type="button" className="fu-ghost-btn" onClick={onCancel} style={{ padding: "8px 14px", fontSize: "13px" }}>
            Cancelar
          </button>
          <button
            type="button"
            className="fu-btn"
            onClick={onConfirm}
            ref={confirmRef}
            style={{
              padding: "8px 16px", border: "none", borderRadius: "6px", cursor: "pointer",
              background: "#DC2626", color: "white", fontSize: "13px", fontWeight: 600, fontFamily: "inherit",
            }}
          >
            No gestionar
          </button>
        </div>
      </div>
    </div>
  );
}

function DismissedList({ orders, onRestore }: { orders: DismissedOrderRow[]; onRestore: (orderId: string) => void }) {
  const [open, setOpen] = useState(false);
  if (orders.length === 0) return null;
  return (
    <div style={{ borderTop: "1px solid #f3f4f6", ...T }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: "6px", width: "100%",
          padding: "12px 16px", border: "none", background: "transparent", cursor: "pointer",
          fontSize: "12px", fontWeight: 600, color: "#6b7280", fontFamily: "inherit", textAlign: "left",
        }}
      >
        <ChevronRight size={14} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s ease" }} />
        Pedidos no gestionados ({orders.length})
      </button>
      {open && orders.map((o, i) => (
        <div key={o.orderId} className="fu-row" style={{
          display: "grid", gridTemplateColumns: ORDER_COLUMNS, alignItems: "center",
          padding: "10px 16px", borderBottom: "1px solid #f9fafb", ...fu(Math.min(i, 8) * 30, 220),
        }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: "#9ca3af" }}>{o.orderNumber}</div>
          <div style={{ fontSize: "13px", color: "#9ca3af" }}>{o.customerName}</div>
          <div style={{ fontSize: "12px", color: "#9ca3af" }}>No gestionado {o.timeAgo}</div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="fu-ghost-btn fu-ghost-brand" onClick={() => onRestore(o.orderId)}>
              Volver a gestionar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function DeliveryTable({ deliveries, highlightId, leavingId }: { deliveries: ActiveDelivery[]; highlightId?: string | null; leavingId?: string }) {
  const now = useNow(15_000);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px", padding: "14px 0 4px", ...T }}>
      {deliveries.map((d, i) => (
        <DeliveryRow key={d.id} d={d} now={now} delay={Math.min(i, 8) * 35} highlight={d.id === highlightId} leaving={d.id === leavingId} />
      ))}
    </div>
  );
}

/** Hora actual que se refresca cada `everyMs`, para las cuentas regresivas. */
function useNow(everyMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function clockTime(iso: string) {
  // Railway corre en UTC: sin timeZone explícito la hora sale corrida ~4 h.
  return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Santiago" });
}

function minutesUntil(iso: string, now: number) {
  return Math.round((new Date(iso).getTime() - now) / 60000);
}

// Pasos que ve la tienda. pickup_complete y dropoff son el mismo paso para ella:
// el paquete ya salió y va camino al cliente.
const DELIVERY_STEPS = ["Buscando conductor", "Va a tu tienda", "Camino al cliente", "Entregado"];
const STEP_BY_STATUS: Record<string, number> = { pending: 0, pickup: 1, pickup_complete: 2, dropoff: 2, delivered: 3 };

function DeliveryRow({ d, now, delay = 0, highlight = false, leaving = false }: { d: ActiveDelivery; now: number; delay?: number; highlight?: boolean; leaving?: boolean }) {
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== "idle";
  const canCancel = !["delivered", "canceled", "returned"].includes(d.status);
  const step = STEP_BY_STATUS[d.status] ?? 0;

  // El conductor está por llegar (o ya llegó) a retirar: lo más importante para la tienda.
  const pickupMin = d.status === "pickup" && d.pickupEta ? minutesUntil(d.pickupEta, now) : null;
  const arriving = pickupMin !== null && pickupMin <= 3;
  const delivered = d.status === "delivered";

  return (
    <div
      className={leaving ? "fu-delivered-out" : highlight ? "fu-just-dispatched" : undefined}
      style={{
        border: `1px solid ${delivered ? "#9FDCC7" : arriving ? "#C9F03C" : "#E4E2F0"}`,
        borderRadius: "12px", background: "white", overflow: "hidden",
        ...(highlight || leaving ? {} : fu(delay)),
      }}
    >
      {/* Encabezado: orden, cliente y acciones */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px", padding: "14px 16px 0" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
            <Link to={`/app/deliveries/${d.id}`} style={{ fontSize: "15px", fontWeight: 700, color: "#4B2BE0", textDecoration: "none" }}>
              {d.orderNumber}
            </Link>
            <span style={{ fontSize: "14px", fontWeight: 600, color: "#241266" }}>{d.customerName}</span>
            <span style={{ fontSize: "12px", color: "#9ca3af" }}>· despachado {d.timeAgo}</span>
          </div>
          <div style={{ fontSize: "13px", color: "#6E6B85", marginTop: "2px" }}>
            {d.customerAddress}, {d.customerComuna}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0 }}>
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

      {/* Progreso */}
      <DeliveryStepper step={step} complete={delivered} />

      {/* Lo que la tienda necesita saber ahora: quién viene y cuándo */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap",
        padding: "12px 16px", borderTop: `1px solid ${delivered ? "#CDEEE2" : arriving ? "#C9F03C" : "#F0EEF7"}`,
        background: delivered ? "#E6F7F2" : arriving ? "#F4FBDD" : "#F6F5FB",
      }}>
        {d.status === "pending" ? (
          <span style={{ fontSize: "13px", color: "#6E6B85" }}>
            Uber está asignando un conductor. Aquí verás quién viene y a qué hora.
          </span>
        ) : (
          <CourierInfo d={d} />
        )}
        <EtaInfo d={d} now={now} pickupMin={pickupMin} arriving={arriving} />
      </div>
    </div>
  );
}

function DeliveryStepper({ step, complete = false }: { step: number; complete?: boolean }) {
  // Al montar, los pasos completados se llenan uno tras otro (120 ms entre cada
  // uno) y después el paso actual empieza a "cargar" en bucle.
  const STAGGER = 120;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${DELIVERY_STEPS.length}, 1fr)`, gap: "6px", padding: "14px 16px" }}>
      {DELIVERY_STEPS.map((label, i) => {
        const done = i < step || complete;
        const current = i === step && !complete;
        return (
          <div key={label} style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: 0 }}>
            <div style={{ position: "relative", height: "4px", borderRadius: "99px", background: "#E4E2F0", overflow: "hidden" }}>
              {done && (
                <div
                  className="fu-step-fill"
                  style={{
                    position: "absolute", inset: 0, background: complete ? "#1D9E75" : "#A99BF0",
                    // Al completarse, solo el último tramo se llena (los demás ya estaban llenos).
                    animationDelay: complete ? "0ms" : `${i * STAGGER}ms`,
                    ...(complete && i < step ? { animation: "none" } : {}),
                  }}
                />
              )}
              {current && (
                <>
                  {/* Base tenue para que el paso actual se distinga aun con la barra vacía */}
                  <div style={{ position: "absolute", inset: 0, background: "#D3CCF9" }} />
                  <div
                    className="fu-step-loading"
                    style={{ position: "absolute", inset: 0, background: "#4B2BE0", animationDelay: `${step * STAGGER}ms` }}
                  />
                </>
              )}
            </div>
            <span style={{
              fontSize: "12px", fontWeight: current ? 600 : 500,
              color: complete && i === DELIVERY_STEPS.length - 1 ? "#1D9E75" : current ? "#241266" : done ? "#6E6B85" : "#B4B1C6",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CourierInfo({ d }: { d: ActiveDelivery }) {
  if (!d.courierName) {
    return <span style={{ fontSize: "13px", color: "#6E6B85" }}>Conductor asignado</span>;
  }
  const vehicle = d.courierVehicle ?? "";
  const VehicleIcon = /moto/i.test(vehicle) ? Motorbike : /bicicleta/i.test(vehicle) ? Bike : Car;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
      <span style={{
        width: "32px", height: "32px", borderRadius: "50%", background: "white", border: "1px solid #E4E2F0",
        display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#4B2BE0",
      }}>
        <VehicleIcon size={16} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "#241266" }}>{d.courierName}</div>
        <div style={{ fontSize: "12px", color: "#6E6B85" }}>
          {d.courierVehicle}
          {d.courierPhone && (
            <>
              {d.courierVehicle ? " · " : ""}
              <a href={`tel:${d.courierPhone}`} style={{ color: "#4B2BE0", textDecoration: "none", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "3px" }}>
                <Phone size={11} strokeWidth={2.25} aria-hidden="true" /> {d.courierPhone}
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EtaInfo({ d, now, pickupMin, arriving }: { d: ActiveDelivery; now: number; pickupMin: number | null; arriving: boolean }) {
  if (d.status === "delivered") {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "#1D9E75" }}>
        <span style={{
          width: "22px", height: "22px", borderRadius: "50%", background: "#1D9E75",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
        }}>
          <Check size={14} color="#FFFFFF" strokeWidth={3} aria-hidden="true" />
        </span>
        <span style={{ fontSize: "15px", fontWeight: 700, fontFamily: "Sora, sans-serif" }}>Entregado</span>
      </div>
    );
  }
  if (d.status === "pickup" && d.pickupEta && pickupMin !== null) {
    return (
      <div style={{ textAlign: "right" }}>
        <div suppressHydrationWarning style={{ fontSize: "15px", fontWeight: 700, color: "#241266", fontFamily: "Sora, sans-serif" }}>
          {arriving ? "Está llegando" : `Llega en ${pickupMin} min`}
        </div>
        <div style={{ fontSize: "12px", color: arriving ? "#241266" : "#6E6B85" }}>
          {arriving ? "Ten el paquete listo para entregarlo" : `a tu tienda · ${clockTime(d.pickupEta)}`}
        </div>
      </div>
    );
  }
  if ((d.status === "pickup_complete" || d.status === "dropoff") && d.dropoffEta) {
    const min = minutesUntil(d.dropoffEta, now);
    return (
      <div style={{ textAlign: "right" }}>
        <div suppressHydrationWarning style={{ fontSize: "15px", fontWeight: 700, color: "#241266", fontFamily: "Sora, sans-serif" }}>
          {min > 0 ? `Entrega en ${min} min` : "Entregando"}
        </div>
        <div style={{ fontSize: "12px", color: "#6E6B85" }}>al cliente · {clockTime(d.dropoffEta)}</div>
      </div>
    );
  }
  return null;
}

function HistoryTable({ deliveries, highlightId }: { deliveries: HistoryDelivery[]; highlightId?: string | null }) {
  return (
    <div style={{ ...T }}>
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr 150px 20px", gap: "12px",
        padding: "8px 16px", borderBottom: "1px solid #f3f4f6",
      }}>
        {["Orden", "Cliente", "Dirección", "Estado", ""].map((h) => (
          <div key={h} style={{ fontSize: "11px", fontWeight: "600", color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {h}
          </div>
        ))}
      </div>
      {deliveries.map((d, i) => (
        <HistoryRow key={d.id} d={d} delay={Math.min(i, 8) * 35} highlight={d.id === highlightId} />
      ))}
    </div>
  );
}

function HistoryRow({ d, delay = 0, highlight = false }: { d: HistoryDelivery; delay?: number; highlight?: boolean }) {
  // Toda la fila lleva al detalle (foto de entrega, conductor, horarios y costo).
  return (
    <Link
      to={`/app/deliveries/${d.id}`}
      className={highlight ? "fu-history-row fu-just-delivered" : "fu-history-row"}
      style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1.3fr 150px 20px", gap: "12px",
        alignItems: "center", padding: "13px 16px", textDecoration: "none",
        borderBottom: "1px solid #f9fafb", background: "white",
        ...(highlight ? {} : fu(delay)),
      }}
    >
      <div>
        <span style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>{d.orderNumber}</span>
        <span style={{ fontSize: "12px", color: "#9ca3af", marginLeft: "8px" }}>{d.timeAgo}</span>
      </div>
      <div style={{ fontSize: "13px", color: "#374151" }}>{d.customerName}</div>
      <div style={{ fontSize: "13px", color: "#6b7280" }}>{d.customerAddress}, {d.customerComuna}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
        <StatusDot status={d.status} />
        <span suppressHydrationWarning style={{ fontSize: "11px", color: "#9ca3af", paddingLeft: "12px" }}>
          {clockTime(d.finishedAt)}
        </span>
      </div>
      <ChevronRight className="fu-chevron" size={16} color="#B4B1C6" aria-hidden="true" />
    </Link>
  );
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    pending:         { label: "Buscando conductor", color: "#EF9F27" },
    pickup:          { label: "Va a tu tienda",    color: "#3B82F6" },
    pickup_complete: { label: "Retirado",          color: "#3B82F6" },
    dropoff:         { label: "Camino al cliente", color: "#4B2BE0" },
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
