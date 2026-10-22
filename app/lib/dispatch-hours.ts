// Horario de despacho de la tienda, siempre en hora de Chile (America/Santiago).
// Un pedido pagado un día de despacho antes de la hora límite sale el mismo día;
// si no, sale el siguiente día de despacho desde la hora de inicio.
// Puro (sin deps de servidor): lo usan el checkout, el panel y los recordatorios.

export const TZ = "America/Santiago";

export type DispatchHours = {
  days: number[];   // 0 = domingo … 6 = sábado
  start: string;    // "09:00" — desde qué hora se despacha
  cutoff: string;   // "19:00" — último pedido que sale el mismo día
};

// Plazo que Fium le promete al cliente en el checkout, en horas desde el pago.
export const DELIVERY_WINDOW_HOURS = [1, 3] as const;

export const DEFAULT_DISPATCH_HOURS: DispatchHours = { days: [1, 2, 3, 4, 5, 6], start: "09:00", cutoff: "19:00" };

export const WEEKDAYS = [
  { value: 1, short: "Lun", long: "lunes" },
  { value: 2, short: "Mar", long: "martes" },
  { value: 3, short: "Mié", long: "miércoles" },
  { value: 4, short: "Jue", long: "jueves" },
  { value: 5, short: "Vie", long: "viernes" },
  { value: 6, short: "Sáb", long: "sábado" },
  { value: 0, short: "Dom", long: "domingo" },
] as const;

const DAY_LONG: Record<number, string> = Object.fromEntries(WEEKDAYS.map((d) => [d.value, d.long]));

/** "1,2,3" (como se guarda en la DB) → [1, 2, 3]. */
export function parseDays(v: string | null | undefined): number[] {
  return (v ?? "")
    .split(",")
    .filter((d) => d.trim() !== "")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

export function isTime(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export function hoursFromConfig(c: { dispatchDays: string; dispatchStart: string; dispatchCutoff: string }): DispatchHours {
  const days = parseDays(c.dispatchDays);
  return {
    days: days.length ? days : DEFAULT_DISPATCH_HOURS.days,
    start: isTime(c.dispatchStart) ? c.dispatchStart : DEFAULT_DISPATCH_HOURS.start,
    cutoff: isTime(c.dispatchCutoff) ? c.dispatchCutoff : DEFAULT_DISPATCH_HOURS.cutoff,
  };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Fecha y hora de Chile para un instante. */
function chileParts(d: Date) {
  const p = Object.fromEntries(PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    weekday: WEEKDAY_INDEX[p.weekday as string],
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Instante que corresponde a una fecha y hora de Chile (respeta el horario de verano). */
function chileInstant(year: number, month: number, day: number, minutes: number): Date {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  // Se corrige por la diferencia entre lo que se pidió y lo que marca Chile en ese instante (dos pasadas por el cambio de hora).
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = chileParts(new Date(t));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
    t += guess - asUtc;
  }
  return new Date(t);
}

/**
 * ¿La tienda está en horario de despacho? Fuera de él Fium no se ofrece en el
 * checkout: la tienda no puede despachar y el precio de Uber cambiaría al otro día.
 */
export function isWithinDispatchHours(at: Date, h: DispatchHours): boolean {
  const p = chileParts(at);
  return h.days.includes(p.weekday) && p.minutes >= toMinutes(h.start) && p.minutes < toMinutes(h.cutoff);
}

/** ¿Un pedido pagado en `at` sale el mismo día? */
export function isSameDayDispatch(at: Date, h: DispatchHours): boolean {
  const p = chileParts(at);
  return h.days.includes(p.weekday) && p.minutes < toMinutes(h.cutoff);
}

export type DispatchPromise = {
  sameDay: boolean;
  startsAt: Date;   // Desde cuándo se puede despachar el pedido
  dayLabel: string; // "hoy", "mañana" o "el lunes"
};

/** Cuándo sale un pedido pagado en `at`. */
export function dispatchPromise(at: Date, h: DispatchHours): DispatchPromise {
  const p = chileParts(at);
  const startMin = toMinutes(h.start);
  if (isSameDayDispatch(at, h)) {
    const opens = chileInstant(p.year, p.month, p.day, startMin);
    return { sameDay: true, startsAt: opens > at ? opens : at, dayLabel: "hoy" };
  }
  for (let offset = 1; offset <= 7; offset++) {
    // Mediodía del día siguiente en Chile, para no caer en el cambio de hora.
    const next = chileParts(new Date(chileInstant(p.year, p.month, p.day, 12 * 60).getTime() + offset * 86_400_000));
    if (!h.days.includes(next.weekday)) continue;
    return {
      sameDay: false,
      startsAt: chileInstant(next.year, next.month, next.day, startMin),
      dayLabel: offset === 1 ? "mañana" : `el ${DAY_LONG[next.weekday]}`,
    };
  }
  // Sin días de despacho configurados: se trata como mismo día.
  return { sameDay: true, startsAt: at, dayLabel: "hoy" };
}

/**
 * Minutos que un pedido lleva esperando desde que se pudo despachar. Un pedido
 * de anoche empieza a contar cuando abre el horario; antes de eso da negativo.
 */
export function minutesWaiting(placedAt: Date, h: DispatchHours, now = new Date()): number {
  return Math.floor((now.getTime() - dispatchPromise(placedAt, h).startsAt.getTime()) / 60_000);
}

/** "anoche, 23:10", "ayer, 15:00", "hoy, 07:30" o "sáb 21 oct, 21:40". */
export function describePlacedAt(placedAt: Date, now = new Date()): string {
  const p = chileParts(placedAt);
  const n = chileParts(now);
  const time = `${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
  const dayDiff = Math.round(
    (Date.UTC(n.year, n.month - 1, n.day) - Date.UTC(p.year, p.month - 1, p.day)) / 86_400_000
  );
  if (dayDiff === 0) return `hoy, ${time}`;
  if (dayDiff === 1) return p.minutes >= 18 * 60 ? `anoche, ${time}` : `ayer, ${time}`;
  const date = placedAt.toLocaleDateString("es-CL", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }).replace(/\./g, "").replace(",", "");
  return `${date}, ${time}`;
}

/** "hoy", "mañana" o "el lunes" para `target`, visto desde `now` (hora de Chile). */
export function relativeDayLabel(target: Date, now = new Date()): string {
  const t = chileParts(target);
  const n = chileParts(now);
  const diff = Math.round((Date.UTC(t.year, t.month - 1, t.day) - Date.UTC(n.year, n.month - 1, n.day)) / 86_400_000);
  if (diff <= 0) return "hoy";
  if (diff === 1) return "mañana";
  return `el ${DAY_LONG[t.weekday]}`;
}

/** "13:15" — hora de Chile en formato 24 h (sin hourCycle, es-CL da "01:15 p. m."). */
export function formatTimeCL(d: Date): string {
  return d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ });
}

/** "Lun a Sáb, 09:00 a 19:00" */
export function describeHours(h: DispatchHours): string {
  const ordered = WEEKDAYS.filter((d) => h.days.includes(d.value));
  const idx = ordered.map((d) => WEEKDAYS.findIndex((w) => w.value === d.value));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const days = ordered.length === 7 ? "Todos los días"
    : contiguous && ordered.length > 2 ? `${ordered[0].short} a ${ordered[ordered.length - 1].short}`
    : ordered.map((d) => d.short).join(", ");
  return `${days}, ${h.start} a ${h.cutoff}`;
}
