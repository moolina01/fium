import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useActionData, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getDelivery, cancelDelivery, getStoreUberCreds } from "../services/uber-direct.server";
import { logError } from "../lib/logger.server";
import { applyUberStatus, describeVehicle, reopenReturnedDelivery } from "../lib/delivery-status.server";
import { colors as F, FONT, DISPLAY_FONT } from "../lib/theme";
import { formatTimeCL } from "../lib/dispatch-hours";

function formatEta(iso: string | null | undefined) {
  if (!iso) return null;
  // Uber devuelve UTC y el server corre en UTC (Railway) — sin timeZone explícito,
  // toLocaleTimeString usa la del proceso, no la de Chile, y queda desfasado ~4h.
  return formatTimeCL(new Date(iso));
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
      const newStatus = await applyUberStatus(delivery, live, "deliveries/detail");
      if (newStatus !== delivery.status) {
        // Cancelado o devuelto: el motivo lo acaba de guardar applyUberStatus.
        const saved = await db.delivery.findUnique({ where: { id: delivery.id }, select: { failureReason: true } });
        delivery.failureReason = saved?.failureReason ?? delivery.failureReason;
      }
      delivery.status = newStatus;
      if (live.trackingUrl) delivery.uberTrackingUrl = live.trackingUrl;
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
      status: delivery.status, // ya actualizado con applyUberStatus
      uberTrackingUrl: live?.trackingUrl || delivery.uberTrackingUrl,
      quoteAmount: delivery.quoteAmount,
      failureReason: delivery.failureReason,
      createdAt: delivery.createdAt.toISOString(),
      // Para un envío terminado, la última actualización es cuándo terminó.
      finishedAt: isTerminal || ["delivered", "canceled", "returned"].includes(delivery.status)
        ? delivery.updatedAt.toISOString()
        : null,
    },
    // Link al pedido en el admin de Shopify (dominio .myshopify.com, siempre válido).
    adminOrderUrl: `https://${session.shop}/admin/orders/${delivery.orderId.split("/").pop()}`,
    storeConfig: storeConfig
      ? { contactName: storeConfig.contactName, address: storeConfig.address, comuna: storeConfig.comuna }
      : null,
    pickupEta: formatEta(live?.pickupEta ?? delivery.pickupEta?.toISOString()),
    dropoffEta: formatEta(live?.dropoffEta ?? delivery.dropoffEta?.toISOString()),
    // En vivo mientras está en curso; para envíos terminados, lo guardado del último sync.
    courier: live?.courier
      ? { name: live.courier.name, phone: live.courier.phone, vehicle: describeVehicle(live.courier), imgHref: live.courier.imgHref }
      : delivery.courierName
        ? { name: delivery.courierName, phone: delivery.courierPhone ?? "", vehicle: delivery.courierVehicle, imgHref: "" }
        : null,
    liveError,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const deliveryId = params.id!;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "resend_returned") {
    const result = await reopenReturnedDelivery(admin, session.shop, deliveryId);
    if ("error" in result) return { error: result.error };
    throw redirect(`/app/orders/${result.orderId}`);
  }

  if (intent === "cancel_delivery") {
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

const TZ = "America/Santiago";

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ });
}

function dayLabel(iso: string) {
  const day = (d: Date) => d.toLocaleDateString("es-CL", { timeZone: TZ });
  if (day(new Date(iso)) === day(new Date())) return "Hoy";
  return new Date(iso).toLocaleDateString("es-CL", { day: "numeric", month: "short", timeZone: TZ });
}

function formatDateTime(iso: string) {
  return `${dayLabel(iso).toLowerCase()} a las ${clock(iso)}`;
}

function durationLabel(fromIso: string, toIso: string) {
  const min = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function formatClp(amount: number) {
  return `$${Math.round(amount).toLocaleString("es-CL")}`;
}

function SummaryStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ padding: "16px 18px", borderRight: `1px solid ${F.border}` }}>
      <div style={{ fontSize: "12px", color: F.muted, marginBottom: "4px" }}>{label}</div>
      <div suppressHydrationWarning style={{ fontSize: "20px", fontWeight: 700, color: F.ink, fontFamily: DISPLAY_FONT }}>{value}</div>
      {hint && <div suppressHydrationWarning style={{ fontSize: "12px", color: F.muted, marginTop: "2px" }}>{hint}</div>}
    </div>
  );
}

const STATUS_MAP: Record<string, { label: string; color: string; description: string }> = {
  pending: { label: "Buscando conductor", color: F.warning, description: "Uber Direct recibió el envío y está asignando un conductor." },
  pickup: { label: "Va a tu tienda", color: "#3B82F6", description: "El conductor va en camino a retirar el pedido. Ten el paquete listo." },
  pickup_complete: { label: "Retirado", color: "#3B82F6", description: "El conductor ya retiró el paquete y va camino al cliente." },
  dropoff: { label: "Camino al cliente", color: F.brand, description: "El conductor está llegando donde el cliente." },
  delivered: { label: "Entregado", color: F.success, description: "El pedido fue entregado." },
  canceled: { label: "Cancelado", color: F.danger, description: "Este envío fue cancelado." },
  returned: { label: "Vuelve a la tienda", color: F.danger, description: "El conductor no pudo entregar y trae el pedido de vuelta a tu tienda." },
  failed: { label: "Falló el despacho", color: F.danger, description: "No se pudo crear el envío en Uber Direct." },
};

export default function DeliveryDetail() {
  const { delivery, storeConfig, pickupEta, dropoffEta, courier, liveError, adminOrderUrl } = useLoaderData<typeof loader>();
  const isFinished = ["delivered", "canceled", "returned"].includes(delivery.status);
  // Prueba de entrega (foto o firma): se pide a Uber al abrir el detalle.
  const proof = useFetcher<{ image?: string; kind?: string; error?: string }>();
  useEffect(() => {
    if (delivery.status === "delivered" && proof.state === "idle" && !proof.data) {
      proof.load(`/app/deliveries/${delivery.id}/proof`);
    }
    // Solo al abrir el envío.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delivery.id, delivery.status]);
  // Mientras el envío sigue en curso, recargar cada 15 s para que el estado, el
  // conductor y la hora de llegada avancen solos (el loader consulta a Uber).
  // Se pausa con la pestaña oculta para no gastar llamadas a Uber.
  const revalidator = useRevalidator();
  const inProgress = !["delivered", "canceled", "returned", "failed"].includes(delivery.status);
  useEffect(() => {
    if (!inProgress) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, 15_000);
    return () => clearInterval(id);
  }, [inProgress, revalidator]);
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
              <div style={{ fontSize: "13px", color: F.muted, marginTop: "2px" }}>
                {statusInfo.description}
                {delivery.finishedAt && <> · {formatDateTime(delivery.finishedAt)}</>}
              </div>
            )}
          </div>
        </div>

        {/* Motivo si el envío falló, Uber lo canceló o lo devolvió */}
        {(delivery.status === "failed" || delivery.status === "returned") && (
          <div style={{ background: F.dangerTint, border: "1px solid #FECACA", borderRadius: "12px", padding: "16px 18px" }}>
            <div style={{ fontSize: "13px", fontWeight: "700", color: F.danger, marginBottom: "4px" }}>
              ¿Qué pasó?
            </div>
            <div style={{ fontSize: "13px", color: "#7F1D1D", lineHeight: "1.6" }}>
              {delivery.status === "returned"
                ? <>
                    {delivery.failureReason ?? "El conductor no pudo entregar el pedido y lo trae de vuelta a tu tienda."}{" "}
                    Asegúrate de que alguien lo reciba; Uber cobra el viaje de vuelta. Después coordina con {delivery.customerName} un nuevo envío o el reembolso en Shopify.
                    <div style={{ marginTop: "10px" }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => fetcher.submit({ intent: "resend_returned" }, { method: "post" })}
                        style={{
                          padding: "7px 14px", border: "none", borderRadius: "6px", cursor: busy ? "default" : "pointer",
                          background: F.danger, color: "white", fontSize: "13px", fontWeight: 600, fontFamily: "inherit",
                          opacity: busy ? 0.6 : 1,
                        }}
                      >
                        Reenviar pedido
                      </button>
                    </div>
                  </>
                : delivery.failureReason ?? "Uber Direct no pudo procesar este envío. Despacha la orden manualmente desde \"Por despachar\"."}
            </div>
          </div>
        )}

        {/* Resumen del envío */}
        <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Resumen
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <SummaryStat label="Costo del envío" value={delivery.quoteAmount != null ? formatClp(delivery.quoteAmount) : "—"} hint="Cobrado por Uber Direct" />
            <SummaryStat label="Despachado" value={clock(delivery.createdAt)} hint={dayLabel(delivery.createdAt)} />
            <SummaryStat
              label={delivery.status === "delivered" ? "Entregado" : isFinished ? "Terminó" : "Entrega estimada"}
              value={delivery.finishedAt ? clock(delivery.finishedAt) : dropoffEta ?? "—"}
              hint={delivery.finishedAt ? dayLabel(delivery.finishedAt) : "Según Uber"}
            />
            {delivery.status === "delivered" && delivery.finishedAt && (
              <SummaryStat label="Tiempo total" value={durationLabel(delivery.createdAt, delivery.finishedAt)} hint="Desde el despacho" />
            )}
          </div>
        </div>

        {/* Prueba de entrega */}
        {delivery.status === "delivered" && (
          <div style={{ background: F.surface, borderRadius: "12px", border: `1px solid ${F.border}`, overflow: "hidden" }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${F.border}`, background: F.bg }}>
              <span style={{ fontSize: "12px", fontWeight: "700", color: F.muted, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                {proof.data?.kind === "signature" ? "Firma de recepción" : "Foto de entrega"}
              </span>
            </div>
            <div style={{ padding: "18px" }}>
              {proof.data?.image ? (
                <img
                  src={proof.data.image}
                  alt="Prueba de entrega tomada por el conductor"
                  style={{ maxWidth: "360px", width: "100%", borderRadius: "10px", border: `1px solid ${F.border}`, display: "block" }}
                />
              ) : proof.data?.error ? (
                <div style={{ fontSize: "13px", color: F.muted }}>{proof.data.error}</div>
              ) : (
                <div style={{ fontSize: "13px", color: F.muted }}>Cargando la prueba de entrega desde Uber…</div>
              )}
            </div>
          </div>
        )}

        {/* Retiro y entrega estimados — responde "¿cuándo pasan a buscar el paquete?" */}
        {!isFinished && (pickupEta || dropoffEta) && (
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
                {isFinished ? "Conductor" : "Conductor asignado"}
              </span>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", alignItems: "center", gap: "12px" }}>
              {courier.imgHref && (
                <img src={courier.imgHref} alt="" width={40} height={40} style={{ borderRadius: "50%", flexShrink: 0 }} />
              )}
              <div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: F.ink }}>{courier.name || "Sin nombre"}</div>
                <div style={{ fontSize: "13px", color: F.muted }}>
                  {[courier.vehicle, courier.phone].filter(Boolean).join(" · ")}
                </div>
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
              {isFinished ? "Ver tracking de Uber ↗" : "Ver tracking en vivo ↗"}
            </a>
          )}
          <a
            href={adminOrderUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              flex: 1, textAlign: "center", padding: "12px", background: F.surface, color: F.brand,
              border: `1.5px solid ${F.brand}`, borderRadius: "8px", fontSize: "14px", fontWeight: "600",
              textDecoration: "none", ...font,
            }}
          >
            Ver pedido en Shopify ↗
          </a>
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
          ← Volver a envíos
        </Link>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
