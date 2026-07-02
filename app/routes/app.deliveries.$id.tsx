import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useActionData, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getDelivery, cancelDelivery, getStoreUberCreds } from "../services/uber-direct.server";
import { logError } from "../lib/logger.server";
import { colors as F, FONT, DISPLAY_FONT } from "../lib/theme";

function formatEta(iso: string | null | undefined) {
  if (!iso) return null;
  // Uber devuelve UTC y el server corre en UTC (Railway) — sin timeZone explícito,
  // toLocaleTimeString usa la del proceso, no la de Chile, y queda desfasado ~4h.
  return new Date(iso).toLocaleTimeString("es-CL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Santiago",
  });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const deliveryId = params.id!;

  const [delivery, storeConfig] = await Promise.all([
    db.delivery.findFirst({ where: { id: deliveryId, shop: session.shop } }),
    db.storeConfig.findUnique({ where: { shop: session.shop } }),
  ]);
  if (!delivery) throw new Response("Envío no encontrado", { status: 404 });

  // El estado guardado ya es el final para deliveries terminados — solo vale la
  // pena consultar a Uber en vivo (courier, ETA de retiro/entrega) mientras el
  // envío sigue en curso.
  const isTerminal = ["delivered", "canceled", "returned", "failed"].includes(delivery.status);
  let live: Awaited<ReturnType<typeof getDelivery>> | null = null;
  let liveError: string | null = null;

  if (!isTerminal && delivery.uberDeliveryId) {
    try {
      const creds = await getStoreUberCreds(session.shop);
      live = await getDelivery(creds, delivery.uberDeliveryId);
      if (live.status !== delivery.status) {
        await db.delivery.update({
          where: { id: delivery.id },
          data: { status: live.status, ...(live.trackingUrl ? { uberTrackingUrl: live.trackingUrl } : {}) },
        });
      }
    } catch (e) {
      logError("deliveries/detail", e, { deliveryId });
      liveError = "No se pudo consultar el estado en vivo de Uber Direct. Mostrando el último estado guardado.";
    }
  }

  return {
    delivery: {
      id: delivery.id,
      orderNumber: delivery.orderNumber,
      customerName: delivery.customerName,
      customerAddress: delivery.customerAddress,
      customerComuna: delivery.customerComuna,
      status: live?.status ?? delivery.status,
      uberTrackingUrl: live?.trackingUrl || delivery.uberTrackingUrl,
      quoteAmount: delivery.quoteAmount,
      failureReason: delivery.failureReason,
      createdAt: delivery.createdAt.toISOString(),
    },
    storeConfig: storeConfig
      ? { contactName: storeConfig.contactName, address: storeConfig.address, comuna: storeConfig.comuna }
      : null,
    pickupEta: formatEta(live?.pickupEta),
    dropoffEta: formatEta(live?.dropoffEta),
    courier: live?.courier ?? null,
    liveError,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const deliveryId = params.id!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "cancel_delivery") {
    const delivery = await db.delivery.findFirst({ where: { id: deliveryId, shop: session.shop } });
    if (!delivery?.uberDeliveryId) return { error: "Envío no encontrado." };
    try {
      const creds = await getStoreUberCreds(session.shop);
      await cancelDelivery(creds, delivery.uberDeliveryId);
      await db.delivery.update({ where: { id: deliveryId }, data: { status: "canceled" } });
      throw redirect("/app");
    } catch (e) {
      if (e instanceof Response) throw e;
      logError("deliveries/detail/cancel", e, { deliveryId, shop: session.shop });
      const msg = e instanceof Error ? e.message : "No se pudo cancelar.";
      return { error: msg };
    }
  }

  return { error: "Acción desconocida." };
};

const STATUS_MAP: Record<string, { label: string; color: string; description: string }> = {
  pending: { label: "Esperando retiro", color: F.warning, description: "Uber Direct ya tiene el envío asignado y está buscando courier." },
  pickup: { label: "Courier en camino a tu tienda", color: "#3B82F6", description: "El courier va en camino a retirar el pedido." },
  pickup_complete: { label: "Paquete recogido", color: "#3B82F6", description: "El courier ya retiró el paquete y va en camino al cliente." },
  dropoff: { label: "En entrega", color: F.brand, description: "El courier está en camino a entregar el pedido al cliente." },
  delivered: { label: "Entregado", color: F.success, description: "El pedido fue entregado." },
  canceled: { label: "Cancelado", color: F.danger, description: "Este envío fue cancelado." },
  returned: { label: "Devuelto", color: F.danger, description: "El courier no pudo entregar y devolvió el paquete." },
  failed: { label: "Falló el despacho", color: F.danger, description: "No se pudo crear el envío en Uber Direct." },
};

export default function DeliveryDetail() {
  const { delivery, storeConfig, pickupEta, dropoffEta, courier, liveError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fetcher = useFetcher<{ error?: string }>();
  const busy = fetcher.state !== "idle";
  const font = { fontFamily: FONT };
  const statusInfo = STATUS_MAP[delivery.status] ?? { label: delivery.status, color: F.muted, description: "" };
  const canCancel = !["delivered", "canceled", "returned", "failed"].includes(delivery.status);

  return (
    <s-page heading={delivery.orderNumber}>
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", ...font }}>

        {(actionData?.error || fetcher.data?.error) && (
          <div style={{
            background: F.dangerTint, border: "1px solid #FECACA", borderRadius: "10px",
            padding: "13px 16px", color: F.danger, fontSize: "14px",
          }}>
            ⚠️ {actionData?.error || fetcher.data?.error}
          </div>
        )}

        {liveError && (
          <div style={{
            background: F.warningTint, border: "1px solid #FDE68A", borderRadius: "10px",
            padding: "13px 16px", color: "#92400E", fontSize: "13px",
          }}>
            ⚠️ {liveError}
          </div>
        )}

        {/* Estado */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, padding: "18px", display: "flex", alignItems: "center", gap: "14px" }}>
          <div style={{ width: "12px", height: "12px", borderRadius: "50%", background: statusInfo.color, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: "16px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>{statusInfo.label}</div>
            {statusInfo.description && (
              <div style={{ fontSize: "13px", color: F.muted, marginTop: "2px" }}>{statusInfo.description}</div>
            )}
          </div>
        </div>

        {/* Motivo si falló el auto-despacho */}
        {delivery.status === "failed" && (
          <div style={{ background: F.dangerTint, border: "1px solid #FECACA", borderRadius: "12px", padding: "16px 18px" }}>
            <div style={{ fontSize: "13px", fontWeight: "700", color: F.danger, marginBottom: "4px" }}>
              ¿Qué pasó?
            </div>
            <div style={{ fontSize: "13px", color: "#7F1D1D", lineHeight: "1.6" }}>
              {delivery.failureReason ?? "Uber Direct no pudo procesar este envío. Despacha la orden manualmente desde \"Por despachar\"."}
            </div>
          </div>
        )}

        {/* Retiro y entrega estimados — responde "¿cuándo pasan a buscar el paquete?" */}
        {(pickupEta || dropoffEta) && (
          <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Horarios estimados
              </span>
            </div>
            <div style={{ padding: "18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <div style={{ background: F.brandTint, borderRadius: "10px", padding: "14px", textAlign: "center" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: F.brand, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>
                  Retiro en tu tienda
                </div>
                <div style={{ fontSize: "22px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>
                  {pickupEta ?? "—"}
                </div>
              </div>
              <div style={{ background: F.bg, borderRadius: "10px", padding: "14px", textAlign: "center", border: `1px solid ${F.border}` }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "6px" }}>
                  Entrega al cliente
                </div>
                <div style={{ fontSize: "22px", fontWeight: "700", color: F.ink, fontFamily: DISPLAY_FONT }}>
                  {dropoffEta ?? "—"}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Courier asignado */}
        {courier && (
          <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Courier asignado
              </span>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: "12px" }}>
              {courier.imgHref && (
                <img src={courier.imgHref} alt="" width={40} height={40} style={{ borderRadius: "50%", flexShrink: 0 }} />
              )}
              <div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: F.ink }}>{courier.name || "Sin nombre"}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{courier.vehicleType} {courier.phone && `· ${courier.phone}`}</div>
              </div>
            </div>
          </div>
        )}

        {/* Ruta */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Ruta del envío
            </span>
          </div>
          <div style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "0" }}>
            <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "3px" }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: F.brand, flexShrink: 0 }} />
                <div style={{ width: "2px", flex: 1, background: F.border, minHeight: "28px", margin: "4px 0" }} />
              </div>
              <div style={{ paddingBottom: "16px" }}>
                <div style={{ fontSize: "11px", fontWeight: "700", color: F.brand, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "3px" }}>Recogida · tu tienda</div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: F.ink }}>{storeConfig?.contactName ?? "—"}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{storeConfig?.address ?? "—"}, {storeConfig?.comuna ?? ""}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "14px", alignItems: "flex-start" }}>
              <div style={{ paddingTop: "3px" }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "2px", background: F.ink, flexShrink: 0 }} />
              </div>
              <div>
                <div style={{ fontSize: "11px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "3px" }}>Entrega · cliente</div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: F.ink }}>{delivery.customerName}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>{delivery.customerAddress}, {delivery.customerComuna}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Acciones */}
        <div style={{ display: "flex", gap: "10px" }}>
          {delivery.uberTrackingUrl && (
            <a
              href={delivery.uberTrackingUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                flex: 1, textAlign: "center", padding: "12px", background: F.brand, color: "#fff",
                borderRadius: "8px", fontSize: "14px", fontWeight: "600", textDecoration: "none", ...font,
              }}
            >
              Ver tracking en vivo ↗
            </a>
          )}
          {canCancel && (
            <fetcher.Form method="post" style={{ flex: 1 }}>
              <input type="hidden" name="intent" value="cancel_delivery" />
              <button
                type="submit"
                disabled={busy}
                style={{
                  width: "100%", padding: "12px", background: F.surface, color: F.danger,
                  border: `1.5px solid ${F.danger}`, borderRadius: "8px", fontSize: "14px",
                  fontWeight: "600", cursor: busy ? "not-allowed" : "pointer", ...font,
                }}
              >
                {busy ? "Cancelando..." : "Cancelar envío"}
              </button>
            </fetcher.Form>
          )}
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
