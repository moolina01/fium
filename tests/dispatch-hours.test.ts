import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPATCH_HOURS as H,
  describeHours,
  describePlacedAt,
  dispatchPromise,
  hoursFromConfig,
  isSameDayDispatch,
  isWithinDispatchHours,
  minutesWaiting,
  parseDays,
  relativeDayLabel,
} from "../app/lib/dispatch-hours";

// Octubre en Chile = horario de verano (UTC-3); julio = invierno (UTC-4).
const cl = (iso: string) => new Date(iso);
const WED_10 = cl("2026-10-21T10:00:00-03:00");

describe("horario de despacho (Lun a Sáb, 09:00 a 19:00)", () => {
  it("dentro del horario: se ofrece Fium", () => {
    expect(isWithinDispatchHours(WED_10, H)).toBe(true);
    expect(isWithinDispatchHours(cl("2026-10-21T09:00:00-03:00"), H)).toBe(true);
  });

  it("antes de abrir, desde la hora límite, y el domingo: no se ofrece", () => {
    expect(isWithinDispatchHours(cl("2026-10-21T08:59:00-03:00"), H)).toBe(false);
    expect(isWithinDispatchHours(cl("2026-10-21T19:00:00-03:00"), H)).toBe(false);
    expect(isWithinDispatchHours(cl("2026-10-21T23:10:00-03:00"), H)).toBe(false);
    expect(isWithinDispatchHours(cl("2026-10-25T12:00:00-03:00"), H)).toBe(false); // domingo
  });

  it("usa la hora de Chile, no la del servidor (UTC)", () => {
    // 01:00 UTC del jueves = 22:00 del miércoles en Chile → fuera de horario.
    expect(isWithinDispatchHours(new Date("2026-10-22T01:00:00Z"), H)).toBe(false);
    // 13:00 UTC = 10:00 en Chile → dentro.
    expect(isWithinDispatchHours(new Date("2026-10-21T13:00:00Z"), H)).toBe(true);
  });

  it("respeta el horario de invierno", () => {
    expect(isWithinDispatchHours(cl("2026-07-15T09:30:00-04:00"), H)).toBe(true);
    expect(isWithinDispatchHours(cl("2026-07-15T19:30:00-04:00"), H)).toBe(false);
  });
});

describe("dispatchPromise", () => {
  const local = (d: Date) => d.toLocaleString("es-CL", { timeZone: "America/Santiago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  it("en horario sale ahora mismo", () => {
    const p = dispatchPromise(WED_10, H);
    expect(p.sameDay).toBe(true);
    expect(p.startsAt).toEqual(WED_10);
  });

  it("de madrugada sale hoy desde la hora de inicio", () => {
    const p = dispatchPromise(cl("2026-10-21T07:30:00-03:00"), H);
    expect(p).toMatchObject({ sameDay: true, dayLabel: "hoy" });
    expect(local(p.startsAt)).toBe("mié, 09:00");
  });

  it("de noche sale mañana a las 09:00", () => {
    const p = dispatchPromise(cl("2026-10-21T23:10:00-03:00"), H);
    expect(p).toMatchObject({ sameDay: false, dayLabel: "mañana" });
    expect(local(p.startsAt)).toBe("jue, 09:00");
  });

  it("el sábado en la noche salta el domingo", () => {
    const p = dispatchPromise(cl("2026-10-24T23:10:00-03:00"), H);
    expect(p.dayLabel).toBe("el lunes");
    expect(local(p.startsAt)).toBe("lun, 09:00");
  });

  it("calcula bien las 09:00 en invierno (UTC-4)", () => {
    expect(dispatchPromise(cl("2026-07-15T22:00:00-04:00"), H).startsAt.toISOString()).toBe("2026-07-16T13:00:00.000Z");
  });
});

describe("minutesWaiting", () => {
  it("un pedido de anoche cuenta desde que abre el horario", () => {
    const placed = cl("2026-10-21T23:10:00-03:00");
    expect(minutesWaiting(placed, H, cl("2026-10-22T08:00:00-03:00"))).toBeLessThan(0);
    expect(minutesWaiting(placed, H, cl("2026-10-22T09:25:00-03:00"))).toBe(25);
  });

  it("un pedido en horario cuenta desde la compra", () => {
    expect(minutesWaiting(WED_10, H, cl("2026-10-21T10:40:00-03:00"))).toBe(40);
  });
});

describe("textos", () => {
  const now = cl("2026-10-22T09:25:00-03:00");
  it("describePlacedAt", () => {
    expect(describePlacedAt(cl("2026-10-22T07:30:00-03:00"), now)).toBe("hoy, 07:30");
    expect(describePlacedAt(cl("2026-10-21T23:10:00-03:00"), now)).toBe("anoche, 23:10");
    expect(describePlacedAt(cl("2026-10-21T15:00:00-03:00"), now)).toBe("ayer, 15:00");
    expect(describePlacedAt(cl("2026-10-18T21:40:00-03:00"), now)).toBe("dom 18 oct, 21:40");
  });

  it("relativeDayLabel", () => {
    expect(relativeDayLabel(cl("2026-10-22T18:00:00-03:00"), now)).toBe("hoy");
    expect(relativeDayLabel(cl("2026-10-23T09:00:00-03:00"), now)).toBe("mañana");
    expect(relativeDayLabel(cl("2026-10-26T09:00:00-03:00"), now)).toBe("el lunes");
  });

  it("describeHours", () => {
    expect(describeHours(H)).toBe("Lun a Sáb, 09:00 a 19:00");
    expect(describeHours({ ...H, days: [1, 3, 5] })).toBe("Lun, Mié, Vie, 09:00 a 19:00");
    expect(describeHours({ ...H, days: [0, 1, 2, 3, 4, 5, 6] })).toBe("Todos los días, 09:00 a 19:00");
  });
});

describe("configuración guardada", () => {
  it("parseDays ignora valores inválidos", () => {
    expect(parseDays("1,2, 7,x,0")).toEqual([1, 2, 0]);
    expect(parseDays(null)).toEqual([]);
  });

  it("hoursFromConfig usa valores por defecto si algo está mal guardado", () => {
    expect(hoursFromConfig({ dispatchDays: "", dispatchStart: "9", dispatchCutoff: "25:00" })).toEqual(H);
    expect(hoursFromConfig({ dispatchDays: "6,0", dispatchStart: "10:00", dispatchCutoff: "14:00" }))
      .toEqual({ days: [6, 0], start: "10:00", cutoff: "14:00" });
  });

  it("isSameDayDispatch: antes de abrir cuenta como mismo día; después del cierre, no", () => {
    expect(isSameDayDispatch(cl("2026-10-21T07:00:00-03:00"), H)).toBe(true);
    expect(isSameDayDispatch(cl("2026-10-21T19:01:00-03:00"), H)).toBe(false);
  });
});
