import { describe, expect, it } from "vitest";
import { normalizeChileanPhone } from "../app/lib/phone";
import { effectiveSize, sizeFromGrams, toPackageSize, weightToGrams, formatKg } from "../app/lib/package-size";
import { buildManifest, parseManifestLines } from "../app/lib/manifest";
import { isEmailFormat } from "../app/lib/email-format";
import { isCancelScenario, roboCourierSpec, toTestScenario, toUndeliverableAction } from "../app/lib/test-scenarios";

describe("teléfonos chilenos → E.164 (lo exige Uber)", () => {
  it.each([
    ["+56 9 1234 5678", "+56912345678"],
    ["912345678", "+56912345678"],
    ["0912345678", "+56912345678"],
    ["12345678", "+56912345678"],
    ["56 9 4937 8795", "+56949378795"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeChileanPhone(raw)).toBe(expected);
  });

  it("devuelve null si no es un teléfono", () => {
    expect(normalizeChileanPhone("")).toBeNull();
    expect(normalizeChileanPhone(null)).toBeNull();
    expect(normalizeChileanPhone("123")).toBeNull();
  });
});

describe("tamaño del paquete según peso", () => {
  it.each([
    [0, null], [1500, "small"], [2000, "small"], [2001, "medium"], [7000, "medium"], [11340, "large"], [11341, "xlarge"], [33000, "xlarge"],
  ])("%i g → %s", (grams, size) => {
    expect(sizeFromGrams(grams)).toBe(size);
  });

  it("'Siempre auto' fuerza Extra grande", () => {
    expect(effectiveSize("small", true)).toBe("xlarge");
    expect(effectiveSize("small", false)).toBe("small");
  });

  it("valores desconocidos caen en medium", () => {
    expect(toPackageSize("gigante")).toBe("medium");
    expect(toPackageSize("large")).toBe("large");
  });

  it("convierte pesos de Shopify y los muestra en kg", () => {
    expect(weightToGrams({ unit: "KILOGRAMS", value: 1.5 })).toBe(1500);
    expect(weightToGrams(null)).toBe(0);
    expect(formatKg(5200)).toBe("5,2 kg");
  });
});

describe("lista de productos para Uber", () => {
  it("manda montos ×100, peso redondeado y omite cantidades en 0", () => {
    const m = buildManifest([
      { title: "Detergente 5L", quantity: 1, grams: 5000.4, unitPrice: 2953 },
      { title: "Esponja", quantity: 2, grams: 0, unitPrice: 0 },
      { title: "Nada", quantity: 0, grams: 100, unitPrice: 100 },
    ], "medium");
    expect(m.items).toEqual([
      { name: "Detergente 5L", quantity: 1, size: "medium", weight: 5000, price: 295300 },
      { name: "Esponja", quantity: 2, size: "medium" },
    ]);
    expect(m.totalValue).toBe(295300);
  });

  it("parseManifestLines tolera datos mal guardados", () => {
    expect(parseManifestLines("no es lista")).toBeNull();
    expect(parseManifestLines([])).toBeNull();
    expect(parseManifestLines([{ title: "A", quantity: "2", grams: null, unitPrice: "10" }, { quantity: 1 }]))
      .toEqual([{ title: "A", quantity: 2, grams: 0, unitPrice: 10 }]);
  });
});

describe("formato de correo", () => {
  it.each(["ventas@tienda.cl", "a.b+c@sub.dominio.com"])("acepta %s", (v) => expect(isEmailFormat(v)).toBe(true));
  it.each(["", "sin-arroba.cl", "a@b", "a @b.cl"])("rechaza '%s'", (v) => expect(isEmailFormat(v)).toBe(false));
});

describe("simulador de pruebas (robo-courier)", () => {
  it("entrega rápida = modo auto", () => {
    expect(roboCourierSpec("fast")).toEqual({ mode: "auto" });
  });

  it("cancelaciones mandan cancel_reason", () => {
    expect(roboCourierSpec("customer_unavailable")).toEqual({ mode: "auto", cancel_reason: "customer_unavailable" });
    expect(isCancelScenario("customer_unavailable")).toBe(true);
    expect(isCancelScenario("slow")).toBe(false);
  });

  it("entrega lenta = modo custom con horas en orden y dentro de los límites de Uber", () => {
    const now = new Date("2026-10-21T13:00:00.000Z");
    const spec = roboCourierSpec("slow", now) as Record<string, string>;
    expect(spec.mode).toBe("custom");
    const keys = ["enroute_for_pickup_at", "pickup_imminent_at", "pickup_at", "dropoff_imminent_at", "dropoff_at"];
    const times = keys.map((k) => new Date(spec[k]).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0] - now.getTime()).toBeLessThanOrEqual(30 * 60_000); // enroute dentro de 30 min
    expect(spec.enroute_for_pickup_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); // sin milisegundos
  });

  it("valores del formulario inválidos caen en lo seguro", () => {
    expect(toTestScenario("hackeo")).toBe("fast");
    expect(toTestScenario("customer_rejected_order")).toBe("customer_rejected_order");
    expect(toUndeliverableAction("cualquiera")).toBe("return");
    expect(toUndeliverableAction("leave_at_door")).toBe("leave_at_door");
  });
});
