// Avisos por correo a la tienda:
//   - Envío con problema: Uber canceló o devolvió el envío, o falló el despacho automático.
//   - Pedido nuevo por despachar (tiendas en despacho manual).
//   - Recordatorio: pedido que sigue sin despachar después de REMINDER_MINUTES.
// Cada tienda elige cuáles recibe y a qué correo en Configuración. Nada de esto
// lanza: si el correo falla, queda en el log y el flujo que lo pidió sigue.
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { sendEmail } from "./email.server";
import { clp, renderEmail, type EmailContent, type EmailItem } from "./email-templates.server";
import { parseManifestLines, type ManifestLine } from "./manifest";
import { logError, logInfo } from "./logger.server";
import { DELIVERY_WINDOW_HOURS, dispatchPromise, formatTimeCL, hoursFromConfig, isSameDayDispatch, isWithinDispatchHours } from "./dispatch-hours";

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
  dispatchDays: string;
  dispatchStart: string;
  dispatchCutoff: string;
  dispatchDayHours: string | null;
};

// ─── Links ──────────────────────────────────────────────────────────────────

/** Link a una pantalla de Fium dentro del admin de Shopify (abre la app embebida). */
function appUrl(shop: string, path: string): string {
  return `https://${shop}/admin/apps/${process.env.SHOPIFY_API_KEY}${path}`;
}

/** Link al pedido en el admin de Shopify. */
function shopifyOrderUrl(shop: string, orderId: string): string {
  return `https://${shop}/admin/orders/${numericId(orderId)}`;
}

const numericId = (gid: string) => gid.split("/").pop() ?? gid;

// ─── Formato ────────────────────────────────────────────────────────────────

/** "22 oct, 10:15" en hora de Chile. */
function dateTimeCL(d: Date): string {
  const day = d.toLocaleDateString("es-CL", { day: "numeric", month: "short", timeZone: "America/Santiago" }).replace(".", "");
  const time = formatTimeCL(d);
  return `${day}, ${time}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Manifest = Awaited<ReturnType<typeof manifestFor>>;

/** Productos con el total por línea, para la tabla del correo. */
function emailItems(lines: ManifestLine[] | null): EmailItem[] {
  return (lines ?? []).map((l) => ({
    quantity: l.quantity,
    title: l.title,
    amount: l.unitPrice > 0 ? l.unitPrice * l.quantity : null,
  }));
}

/** Total pagado por el cliente (incluye el envío) o, si no está, la suma de productos. */
function emailTotals(m: Manifest, lines: ManifestLine[] | null): Array<[string, string]> {
  if (m?.orderTotal) return [["Total pagado por el cliente", clp(m.orderTotal)]];
  const sum = (lines ?? []).reduce((acc, l) => acc + l.unitPrice * l.quantity, 0);
  return sum > 0 ? [["Total productos", clp(sum)]] : [];
}

function weightRow(lines: ManifestLine[] | null): Array<[string, string]> {
  const kg = (lines ?? []).reduce((sum, l) => sum + l.grams * l.quantity, 0) / 1000;
  return kg > 0 ? [["Peso total", `${kg.toLocaleString("es-CL", { maximumFractionDigits: 1 })} kg`]] : [];
}

async function manifestFor(shop: string, orderId: string) {
  return db.orderManifest.findUnique({ where: { shop_orderId: { shop, orderId } } });
}

/**
 * Config de avisos de la tienda. notifyEmail: null = nunca se configuró (tiendas
 * instaladas antes de los avisos): se usa el correo de la tienda en Shopify y se
 * guarda. "" = la tienda lo borró a propósito en Configuración: no se le escribe.
 */
async function configFor(shop: string): Promise<Config | null> {
  const config = await db.storeConfig.findUnique({
    where: { shop },
    select: {
      shop: true, contactName: true, notifyEmail: true, notifyCanceled: true,
      notifyNewOrder: true, notifyReminder: true, autoDispatch: true,
      dispatchDays: true, dispatchStart: true, dispatchCutoff: true, dispatchDayHours: true,
    },
  });
  if (!config || config.notifyEmail !== null) return config;
  try {
    const { admin } = await unauthenticated.admin(shop);
    const res = await admin.graphql(`#graphql
      query NotifyShopEmail { shop { email } }`);
    const email: string | null = (await res.json()).data?.shop?.email?.trim().toLowerCase() || null;
    if (!email) return config;
    await db.storeConfig.updateMany({ where: { shop, notifyEmail: null }, data: { notifyEmail: email } });
    logInfo("notify/default-email", "Se usó el correo de la tienda en Shopify para los avisos", { shop });
    return { ...config, notifyEmail: email };
  } catch (err) {
    logError("notify/default-email", err, { shop });
    return config;
  }
}

async function deliver(config: Config, content: EmailContent, subject: string, context: string, idempotencyKey: string) {
  if (!config.notifyEmail) return false;
  const { html, text } = renderEmail(content);
  const ok = await sendEmail({ to: config.notifyEmail, subject, html, text, idempotencyKey }, context);
  if (ok) logInfo(context, "Aviso por correo enviado", { shop: config.shop, subject });
  return ok;
}

/** Filas del cliente para pedidos que aún no tienen envío (nuevo y recordatorio). */
/**
 * Lo que se le prometió al cliente: entrega antes de pago + DELIVERY_WINDOW_HOURS[1].
 * Si pagó fuera de horario (empezó el checkout justo antes del cierre), se avisa.
 */
function promisedDelivery(m: NonNullable<Manifest>, config: Config): string {
  if (!isWithinDispatchHours(m.createdAt, hoursFromConfig(config))) {
    return "Pagado fuera de tu horario de despacho: despáchalo apenas puedas";
  }
  const deadline = new Date(m.createdAt.getTime() + DELIVERY_WINDOW_HOURS[1] * 3_600_000);
  const time = formatTimeCL(deadline);
  return `Antes de las ${time} (${DELIVERY_WINDOW_HOURS[0]} a ${DELIVERY_WINDOW_HOURS[1]} horas desde el pago)`;
}

function pendingOrderDetails(m: NonNullable<Manifest>, lines: ManifestLine[] | null, config: Config): Array<[string, string]> {
  return [
    ["Pedido", m.orderNumber ?? ""],
    ["Pagado", dateTimeCL(m.createdAt)],
    ["Entrega prometida", promisedDelivery(m, config)],
    ["Cliente", m.customerName ?? "No informado"],
    ["Teléfono", m.customerPhone ?? "No informado"],
    ["Dirección", [m.customerAddress, m.customerComuna].filter(Boolean).join(", ") || "No informada"],
    ...(m.orderNote ? [["Nota del cliente", m.orderNote] as [string, string]] : []),
    ...weightRow(lines),
  ];
}

// ─── 1. Envío con problema ──────────────────────────────────────────────────

export type ProblemKind = "canceled" | "returned" | "auto_failed";

const PROBLEM_COPY: Record<ProblemKind, {
  subject: (n: string) => string; title: (n: string) => string; intro: string;
  notice: string; event: string; cta: string;
}> = {
  canceled: {
    subject: (n) => `Acción requerida: Uber canceló el envío del pedido ${n}`,
    title: (n) => `Uber canceló el envío del pedido ${n}`,
    intro: "El pedido volvió a Por despachar en Fium y el cliente todavía no lo recibe. Revisa el motivo y vuelve a despacharlo, o contacta al cliente para coordinar la entrega.",
    notice: "Motivo informado por Uber",
    event: "Cancelado",
    cta: "Volver a despachar",
  },
  returned: {
    subject: (n) => `Acción requerida: el pedido ${n} vuelve a tu tienda`,
    title: (n) => `El pedido ${n} no se pudo entregar`,
    intro: "El conductor viene de vuelta a tu tienda con el pedido: asegúrate de que alguien lo reciba. Uber cobra el viaje de vuelta. Después contacta al cliente para reenviarlo desde Fium o reembolsarlo en Shopify.",
    notice: "Motivo informado por Uber",
    event: "Inicio de la devolución",
    cta: "Ver el envío en Fium",
  },
  auto_failed: {
    subject: (n) => `Acción requerida: no se pudo crear el envío del pedido ${n}`,
    title: (n) => `No se pudo crear el envío del pedido ${n}`,
    intro: "Fium intentó crear el envío automáticamente y Uber lo rechazó. El pedido quedó en Por despachar para que lo despaches a mano.",
    notice: "Respuesta de Uber",
    event: "Intento de envío",
    cta: "Despachar en Fium",
  },
};

/**
 * Avisa que un envío tuvo un problema. `reason` es el motivo en español, corto
 * ("el cliente no estaba disponible…") o el mensaje de error de Uber.
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
    const lines = parseManifestLines(manifest?.items);
    const courier = [delivery.courierName, delivery.courierVehicle].filter(Boolean).join(", ");
    const details: Array<[string, string]> = [
      ["Pedido", delivery.orderNumber],
      ["Cliente", delivery.customerName],
      ["Teléfono", manifest?.customerPhone ?? "No informado"],
      ["Dirección", `${delivery.customerAddress}, ${delivery.customerComuna}`],
      ...(manifest?.orderNote ? [["Nota del cliente", manifest.orderNote] as [string, string]] : []),
      ...(courier ? [["Conductor", courier] as [string, string]] : []),
      ...(delivery.quoteAmount ? [["Costo del envío", clp(delivery.quoteAmount)] as [string, string]] : []),
      ...(kind !== "auto_failed" ? [["Envío creado", dateTimeCL(delivery.createdAt)] as [string, string]] : []),
      [copy.event, dateTimeCL(new Date())],
      ...(delivery.uberDeliveryId ? [["ID de envío en Uber", delivery.uberDeliveryId] as [string, string]] : []),
    ];
    const primaryUrl = kind === "returned"
      ? appUrl(delivery.shop, `/app/deliveries/${delivery.id}`)
      : appUrl(delivery.shop, `/app/orders/${numericId(delivery.orderId)}`);

    await deliver(config, {
      storeName: config.contactName,
      label: "Acción requerida",
      urgent: true,
      title: copy.title(delivery.orderNumber),
      intro: copy.intro,
      notice: reason ? { heading: copy.notice, body: capitalize(reason.replace(/\.$/, "")) + "." } : undefined,
      details,
      items: emailItems(lines),
      totals: emailTotals(manifest, lines),
      primary: { label: copy.cta, url: primaryUrl },
      secondary: { label: "Ver pedido en Shopify", url: shopifyOrderUrl(delivery.shop, delivery.orderId) },
      footer: "Recibes este correo porque tienes activados los avisos de envíos con problemas.",
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

    await deliver(config, {
      storeName: config.contactName,
      label: "Nuevo pedido",
      title: `Pedido ${manifest.orderNumber} listo para despachar`,
      intro: `Tu cliente pagó Fium Express, que promete la entrega en ${DELIVERY_WINDOW_HOURS[0]} a ${DELIVERY_WINDOW_HOURS[1]} horas. Prepara el paquete y crea el envío en Fium para que un conductor de Uber lo retire en tu tienda.`,
      details: pendingOrderDetails(manifest, lines, config),
      items: emailItems(lines),
      totals: emailTotals(manifest, lines),
      primary: { label: "Preparar envío en Fium", url: appUrl(shop, `/app/orders/${numericId(orderId)}`) },
      secondary: { label: "Ver pedido en Shopify", url: shopifyOrderUrl(shop, orderId) },
      footer: "Recibes este correo porque tienes activados los avisos de pedidos nuevos.",
    }, `Nuevo pedido ${manifest.orderNumber} para despachar con Uber`, context, `new:${shop}:${orderId}`);
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
  // Candidatos de los últimos días: un pedido del sábado en la noche puede
  // recordarse recién el lunes cuando abre el horario.
  const candidates = await db.orderManifest.findMany({
    where: {
      reminderSentAt: null,
      orderNumber: { not: null },
      createdAt: { lte: new Date(now - REMINDER_MINUTES * 60_000), gte: new Date(now - 4 * 86_400_000) },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });

  const configs = new Map<string, Config | null>();
  for (const m of candidates) {
    try {
      if (!configs.has(m.shop)) configs.set(m.shop, await configFor(m.shop));
      const config = configs.get(m.shop) ?? null;

      // Se recuerda REMINDER_MINUTES después de que se pudo despachar: un pedido de
      // anoche cuenta desde que abre el horario, no desde la compra.
      const dueAt = dispatchPromise(m.createdAt, config ? hoursFromConfig(config) : { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", cutoff: "23:59" }).startsAt.getTime() + REMINDER_MINUTES * 60_000;
      if (dueAt > now) continue;
      const tooLate = now - dueAt > REMINDER_MAX_AGE_HOURS * 3_600_000;

      // Se reclama primero: si dos procesos corren a la vez, solo uno manda el correo.
      const claimed = await db.orderManifest.updateMany({ where: { id: m.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
      if (claimed.count === 0 || tooLate) continue;

      if (!config?.notifyReminder || !config.notifyEmail || config.autoDispatch) continue;
      const [delivery, dismissed] = await Promise.all([
        db.delivery.findUnique({ where: { shop_orderId: { shop: m.shop, orderId: m.orderId } } }),
        db.dismissedOrder.findUnique({ where: { shop_orderId: { shop: m.shop, orderId: m.orderId } } }),
      ]);
      if (delivery || dismissed) continue;
      if (!(await stillPending(m.shop, m.orderId))) continue;

      const lines = parseManifestLines(m.items);
      const waited = Math.round((now - (dueAt - REMINDER_MINUTES * 60_000)) / 60_000);
      const outOfHours = !isSameDayDispatch(m.createdAt, hoursFromConfig(config));
      await deliver(config, {
        storeName: config.contactName,
        label: "Recordatorio",
        title: outOfHours
          ? `El pedido ${m.orderNumber} sigue sin despachar`
          : `El pedido ${m.orderNumber} lleva ${waited} minutos sin despachar`,
        intro: outOfHours
          ? `Se pagó fuera de tu horario de despacho. Ya abrió tu horario hace ${waited} minutos y todavía no se ha creado el envío en Uber.`
          : `Tu cliente pagó Fium Express, que promete la entrega en ${DELIVERY_WINDOW_HOURS[0]} a ${DELIVERY_WINDOW_HOURS[1]} horas, y todavía no se ha creado el envío en Uber.`,
        details: pendingOrderDetails(m, lines, config),
        items: emailItems(lines),
        totals: emailTotals(m, lines),
        primary: { label: "Despachar en Fium", url: appUrl(m.shop, `/app/orders/${numericId(m.orderId)}`) },
        secondary: { label: "Ver pedido en Shopify", url: shopifyOrderUrl(m.shop, m.orderId) },
        footer: "Recibes este correo porque tienes activados los recordatorios de pedidos sin despachar.",
      }, outOfHours
        ? `Recordatorio: el pedido ${m.orderNumber} sigue sin despachar`
        : `Recordatorio: el pedido ${m.orderNumber} lleva ${waited} minutos sin despachar`, context, `reminder:${m.shop}:${m.orderId}`);
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
    label: "Correo de prueba",
    title: "Los avisos de Fium llegarán a este correo",
    intro: "La configuración quedó lista. Te escribiremos aquí cuando un envío tenga un problema o un pedido esté esperando su despacho.",
    details: [["Tienda", shop], ["Correo de avisos", to], ["Enviado", dateTimeCL(new Date())]],
    primary: { label: "Abrir Fium", url: appUrl(shop, "/app") },
    footer: "Recibes este correo porque pediste una prueba desde Fium.",
  }, "Prueba de avisos de Fium", "notify/test", `test:${shop}:${Date.now()}`);
}
