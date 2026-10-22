// Avisos por correo a la tienda:
//   - Envío con problema: Uber canceló o devolvió el envío, o falló el despacho automático.
//   - Pedido nuevo por despachar (tiendas en despacho manual).
//   - Recordatorio: pedido que sigue sin despachar después de REMINDER_MINUTES.
// Cada tienda elige cuáles recibe y a qué correo en Configuración. Nada de esto
// lanza: si el correo falla, queda en el log y el flujo que lo pidió sigue.
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendEmail } from "./email.server";
import { renderEmail, type EmailContent } from "./email-templates.server";
import { parseManifestLines, type ManifestLine } from "./manifest";
import { logError, logInfo } from "./logger.server";

export const REMINDER_MINUTES = 20;
// Pedidos más antiguos que esto no reciben recordatorio (ej. justo después de un
// deploy, o si el servidor estuvo caído): avisar de un pedido de ayer no ayuda.
const REMINDER_MAX_AGE_HOURS = 6;
const SWEEP_EVERY_MS = 2 * 60_000;

type Config = {
  shop: string;
  contactName: string;
  notifyEmail: string | null;
  notifyCanceled: boolean;
  notifyNewOrder: boolean;
  notifyReminder: boolean;
  autoDispatch: boolean;
};

// ─── Links al admin ─────────────────────────────────────────────────────────

/** Link a una pantalla de Fium dentro del admin de Shopify (abre la app embebida). */
function appUrl(shop: string, path: string): string {
  return `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}${path}`;
}

const numericId = (gid: string) => gid.split("/").pop() ?? gid;

// ─── Formato ────────────────────────────────────────────────────────────────

function timeCL(d: Date): string {
  return d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: "America/Santiago" });
}

function itemsText(lines: ManifestLine[] | null): string | null {
  if (!lines?.length) return null;
  const shown = lines.slice(0, 6).map((l) => `${l.quantity}× ${l.title}`);
  if (lines.length > 6) shown.push(`y ${lines.length - 6} productos más`);
  return shown.join("\n");
}

async function manifestFor(shop: string, orderId: string) {
  return db.orderManifest.findUnique({ where: { shop_orderId: { shop, orderId } } });
}

async function configFor(shop: string): Promise<Config | null> {
  return db.storeConfig.findUnique({
    where: { shop },
    select: {
      shop: true, contactName: true, notifyEmail: true, notifyCanceled: true,
      notifyNewOrder: true, notifyReminder: true, autoDispatch: true,
    },
  });
}

async function deliver(config: Config, content: EmailContent, subject: string, context: string, idempotencyKey: string) {
  if (!config.notifyEmail) return false;
  const { html, text } = renderEmail(content);
  const ok = await sendEmail({ to: config.notifyEmail, subject, html, text, idempotencyKey }, context);
  if (ok) logInfo(context, "Aviso por correo enviado", { shop: config.shop, subject });
  return ok;
}

// ─── 1. Envío con problema ──────────────────────────────────────────────────

export type ProblemKind = "canceled" | "returned" | "auto_failed";

const PROBLEM_COPY: Record<ProblemKind, { subject: (n: string) => string; title: (n: string) => string; intro: string; cta: string }> = {
  canceled: {
    subject: (n) => `⚠️ Uber canceló el envío del pedido ${n}`,
    title: (n) => `Uber canceló el envío del pedido ${n}`,
    intro: "El pedido volvió a \"Por despachar\" en Fium. Revisa el motivo y vuelve a despacharlo, o coordina con el cliente.",
    cta: "Volver a despachar",
  },
  returned: {
    subject: (n) => `⚠️ El pedido ${n} vuelve a tu tienda`,
    title: (n) => `El conductor no pudo entregar el pedido ${n}`,
    intro: "El conductor está devolviendo el pedido a tu tienda. Cuando llegue, coordina con el cliente una nueva entrega.",
    cta: "Ver el envío",
  },
  auto_failed: {
    subject: (n) => `⚠️ No se pudo crear el envío del pedido ${n}`,
    title: (n) => `No se pudo crear el envío del pedido ${n}`,
    intro: "Fium intentó crear el envío automáticamente y Uber lo rechazó. El pedido quedó en \"Por despachar\" para que lo despaches a mano.",
    cta: "Despachar a mano",
  },
};

/**
 * Avisa que un envío tuvo un problema. `reason` es el texto en español que ya
 * se guarda en failureReason (ver delivery-status.server.ts).
 */
export async function notifyDeliveryProblem(deliveryId: string, kind: ProblemKind, reason: string | null): Promise<void> {
  const context = `notify/${kind}`;
  try {
    const delivery = await db.delivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return;
    const config = await configFor(delivery.shop);
    if (!config?.notifyCanceled || !config.notifyEmail) return;

    const copy = PROBLEM_COPY[kind];
    const manifest = await manifestFor(delivery.shop, delivery.orderId);
    const items = itemsText(parseManifestLines(manifest?.items));
    const facts: Array<[string, string]> = [
      ["Cliente", delivery.customerName],
      ["Dirección", `${delivery.customerAddress}, ${delivery.customerComuna}`],
      ...(items ? [["Productos", items] as [string, string]] : []),
      ["Hora", `Hoy a las ${timeCL(new Date())}`],
    ];
    const url = kind === "returned"
      ? appUrl(delivery.shop, `/app/deliveries/${delivery.id}`)
      : appUrl(delivery.shop, `/app/orders/${numericId(delivery.orderId)}`);

    await deliver(config, {
      storeName: config.contactName,
      tone: "danger",
      banner: "Requiere tu atención",
      title: copy.title(delivery.orderNumber),
      callout: reason ?? undefined,
      intro: copy.intro,
      facts,
      cta: { label: copy.cta, url },
      footer: "Recibes este correo porque tienes activados los avisos de envíos con problemas en Fium.",
    }, copy.subject(delivery.orderNumber), context, `${kind}:${delivery.id}:${delivery.uberDeliveryId ?? ""}`);
  } catch (err) {
    logError(context, err, { deliveryId });
  }
}

// ─── 2. Pedido nuevo por despachar ──────────────────────────────────────────

export async function notifyNewOrder(shop: string, orderId: string): Promise<void> {
  const context = "notify/new-order";
  try {
    const config = await configFor(shop);
    if (!config?.notifyNewOrder || !config.notifyEmail || config.autoDispatch) return;
    const manifest = await manifestFor(shop, orderId);
    if (!manifest?.orderNumber) return;

    const lines = parseManifestLines(manifest.items);
    const items = itemsText(lines);
    const kg = (lines ?? []).reduce((sum, l) => sum + l.grams * l.quantity, 0) / 1000;
    const facts: Array<[string, string]> = [
      ["Cliente", manifest.customerName ?? "—"],
      ["Comuna", manifest.customerComuna ?? "—"],
      ...(items ? [["Productos", items] as [string, string]] : []),
      ...(kg > 0 ? [["Peso", `${kg.toLocaleString("es-CL", { maximumFractionDigits: 1 })} kg`] as [string, string]] : []),
    ];

    await deliver(config, {
      storeName: config.contactName,
      tone: "brand",
      banner: "Nuevo pedido por despachar",
      title: `El pedido ${manifest.orderNumber} está esperando su envío`,
      intro: "Tu cliente pagó un envío express con Uber Direct. Prepara el paquete y crea el envío para que un conductor lo pase a buscar.",
      facts,
      cta: { label: "Preparar y enviar", url: appUrl(shop, `/app/orders/${numericId(orderId)}`) },
      footer: "Recibes este correo porque tienes activados los avisos de pedidos nuevos en Fium.",
    }, `Pedido ${manifest.orderNumber} listo para enviar con Uber`, context, `new:${shop}:${orderId}`);
  } catch (err) {
    logError(context, err, { shop, orderId });
  }
}

// ─── 3. Recordatorio de pedido sin despachar ────────────────────────────────

/** ¿El pedido sigue abierto y sin enviar en Shopify? (pudo enviarse fuera de Fium). */
async function stillPending(shop: string, orderId: string): Promise<boolean> {
  const { admin } = await unauthenticated.admin(shop);
  const res = await admin.graphql(`#graphql
    query ReminderOrder($id: ID!) { order(id: $id) { cancelledAt closed displayFulfillmentStatus } }`,
    { variables: { id: orderId } });
  const order = (await res.json()).data?.order;
  if (!order) return false;
  return !order.cancelledAt && !order.closed && order.displayFulfillmentStatus === "UNFULFILLED";
}

export async function runReminderSweep(): Promise<void> {
  const context = "notify/reminder";
  const now = Date.now();
  const due = await db.orderManifest.findMany({
    where: {
      reminderSentAt: null,
      orderNumber: { not: null },
      createdAt: { lte: new Date(now - REMINDER_MINUTES * 60_000), gte: new Date(now - REMINDER_MAX_AGE_HOURS * 3_600_000) },
    },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  for (const m of due) {
    try {
      // Se reclama primero: si dos procesos corren a la vez, solo uno manda el correo.
      const claimed = await db.orderManifest.updateMany({ where: { id: m.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
      if (claimed.count === 0) continue;

      const config = await configFor(m.shop);
      if (!config?.notifyReminder || !config.notifyEmail || config.autoDispatch) continue;
      const [delivery, dismissed] = await Promise.all([
        db.delivery.findUnique({ where: { shop_orderId: { shop: m.shop, orderId: m.orderId } } }),
        db.dismissedOrder.findUnique({ where: { shop_orderId: { shop: m.shop, orderId: m.orderId } } }),
      ]);
      if (delivery || dismissed) continue;
      if (!(await stillPending(m.shop, m.orderId))) continue;

      const items = itemsText(parseManifestLines(m.items));
      const waited = Math.round((now - m.createdAt.getTime()) / 60_000);
      await deliver(config, {
        storeName: config.contactName,
        tone: "warning",
        banner: "Recordatorio",
        title: `El pedido ${m.orderNumber} lleva ${waited} minutos esperando`,
        intro: `${m.customerName ?? "Tu cliente"} pagó un envío express${m.customerComuna ? ` a ${m.customerComuna}` : ""} a las ${timeCL(m.createdAt)} y todavía no se ha creado el envío en Uber. Mientras más espere, más tarde le llega.`,
        facts: [
          ["Pagado", `Hoy a las ${timeCL(m.createdAt)}`],
          ...(items ? [["Productos", items] as [string, string]] : []),
        ],
        cta: { label: "Despachar ahora", url: appUrl(m.shop, `/app/orders/${numericId(m.orderId)}`) },
        footer: "Recibes este correo porque tienes activados los recordatorios de pedidos sin despachar en Fium.",
      }, `El pedido ${m.orderNumber} lleva ${waited} min sin despachar`, context, `reminder:${m.shop}:${m.orderId}`);
    } catch (err) {
      logError(context, err, { shop: m.shop, orderId: m.orderId });
    }
  }
}

/**
 * Revisa los recordatorios cada 2 minutos mientras el servidor esté arriba.
 * Fium corre en una sola instancia; igual el "reclamo" de runReminderSweep evita
 * correos duplicados si alguna vez hay más de una.
 */
export function startReminderLoop(): void {
  const g = globalThis as { __fiumReminderLoop?: ReturnType<typeof setInterval> };
  if (g.__fiumReminderLoop) return;
  g.__fiumReminderLoop = setInterval(() => {
    runReminderSweep().catch((err) => logError("notify/reminder-loop", err));
  }, SWEEP_EVERY_MS);
  g.__fiumReminderLoop.unref?.();
}

// ─── Correo de prueba (Configuración) ───────────────────────────────────────

export async function sendTestNotification(shop: string, to: string): Promise<boolean> {
  const config = await configFor(shop);
  if (!config) return false;
  return deliver({ ...config, notifyEmail: to }, {
    storeName: config.contactName,
    tone: "brand",
    banner: "Correo de prueba",
    title: "Los avisos de Fium llegan a este correo",
    intro: "Si estás leyendo esto, todo quedó bien configurado. Te avisaremos aquí cuando un envío tenga un problema o haya pedidos esperando.",
    facts: [["Tienda", shop], ["Enviado", `Hoy a las ${timeCL(new Date())}`]],
    cta: { label: "Abrir Fium", url: appUrl(shop, "/app") },
    footer: "Recibes este correo porque pediste un correo de prueba desde Fium.",
  }, "Prueba de avisos de Fium", "notify/test", `test:${shop}:${Date.now()}`);
}
