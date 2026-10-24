import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Checkout: Shopify le pide la tarifa a Fium. Se simulan la DB y Uber.
const db = vi.hoisted(() => ({ storeConfig: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: db }));
const uber = vi.hoisted(() => ({ getDeliveryQuote: vi.fn() }));
vi.mock("../app/services/uber-direct.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("../app/services/uber-direct.server")>();
  return {
    ...real,
    getDeliveryQuote: uber.getDeliveryQuote,
    uberCredsFromConfig: (c: { uberClientId: string | null }) => {
      if (!c.uberClientId) throw new real.UberNotConfiguredError();
      return { clientId: "c", clientSecret: "s", customerId: "cust" };
    },
  };
});

import { action } from "../app/routes/carrier.rates";
import { UberApiError } from "../app/services/uber-direct.server";

const SHOP = "tienda.myshopify.com";
const store = {
  shop: SHOP, address: "Av. Providencia 1234", comuna: "Providencia", region: "RM", zipCode: "7500000",
  uberClientId: "c", uberClientSecret: "enc", uberCustomerId: "cust",
  dispatchDays: "1,2,3,4,5,6", dispatchStart: "09:00", dispatchCutoff: "19:00", lastRateRequestAt: new Date(),
};

let n = 0;
function rateRequest(overrides: { items?: unknown[]; destination?: Record<string, string>; hmac?: string } = {}) {
  // Dirección distinta en cada prueba para no chocar con el cache de cotizaciones.
  n++;
  const body = JSON.stringify({
    rate: {
      destination: { address1: `Av. Grecia ${2000 + n}`, city: "Ñuñoa", province: "RM", postal_code: "", ...overrides.destination },
      items: overrides.items ?? [{ grams: 1500, quantity: 2, requires_shipping: true }],
    },
  });
  const hmac = overrides.hmac ?? createHmac("sha256", "test-api-secret").update(body).digest("base64");
  return new Request("https://app/carrier/rates", {
    method: "POST", body,
    headers: { "X-Shopify-Hmac-Sha256": hmac, "X-Shopify-Shop-Domain": SHOP, "Content-Type": "application/json" },
  });
}

async function rates(req: Request) {
  const res = await action({ request: req, params: {}, context: {} } as never);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T10:00:00-03:00")); // miércoles 10:00 en Chile
  db.storeConfig.findUnique.mockResolvedValue(store);
  uber.getDeliveryQuote.mockResolvedValue({ id: "q1", fee: 295300, currency: "clp", duration: 39, expires: "", dropoffEta: "" });
});
afterEach(() => vi.useRealTimers());

describe("tarifa de Fium en el checkout", () => {
  it("en horario ofrece Fium Express con el precio de Uber, sin mencionar a Uber", async () => {
    const { body } = await rates(rateRequest());
    expect(body.rates).toHaveLength(1);
    const rate = body.rates[0];
    expect(rate).toMatchObject({
      service_name: "Fium Express — llega en 1 a 3 horas",
      description: "Despacho el mismo día",
      service_code: "uber_direct",
      total_price: "295300", // Shopify divide por 100 → $2.953
      currency: "CLP",
    });
    expect(`${rate.service_name} ${rate.description}`).not.toMatch(/uber/i);
    const ahora = Date.now();
    expect(new Date(rate.min_delivery_date).getTime() - ahora).toBe(1 * 3_600_000);
    expect(new Date(rate.max_delivery_date).getTime() - ahora).toBe(3 * 3_600_000);
  });

  it("rechaza pedidos sin firma válida de Shopify", async () => {
    const { status } = await rates(rateRequest({ hmac: "firma-falsa" }));
    expect(status).toBe(401);
    expect(uber.getDeliveryQuote).not.toHaveBeenCalled();
  });

  it.each([
    ["de noche", "2026-10-21T22:00:00-03:00"],
    ["antes de abrir", "2026-10-21T08:30:00-03:00"],
    ["justo a la hora límite", "2026-10-21T19:00:00-03:00"],
    ["un domingo", "2026-10-25T12:00:00-03:00"],
  ])("fuera de horario (%s) no aparece", async (_, at) => {
    vi.setSystemTime(new Date(at));
    const { body } = await rates(rateRequest());
    expect(body.rates).toEqual([]);
    expect(uber.getDeliveryQuote).not.toHaveBeenCalled();
  });

  it("respeta el horario configurado por la tienda", async () => {
    db.storeConfig.findUnique.mockResolvedValue({ ...store, dispatchDays: "0", dispatchStart: "10:00", dispatchCutoff: "14:00" });
    vi.setSystemTime(new Date("2026-10-25T12:00:00-03:00")); // domingo
    expect((await rates(rateRequest())).body.rates).toHaveLength(1);
  });

  it("sin calle o comuna todavía no cotiza", async () => {
    expect((await rates(rateRequest({ destination: { address1: "", city: "Ñuñoa" } }))).body.rates).toEqual([]);
    expect((await rates(rateRequest({ destination: { address1: "Calle 1", city: "" } }))).body.rates).toEqual([]);
  });

  it("productos sin peso, un producto de más de 22,65 kg o carrito de más de 33 kg: no aparece", async () => {
    expect((await rates(rateRequest({ items: [{ grams: 0, quantity: 1 }] }))).body.rates).toEqual([]);
    expect((await rates(rateRequest({ items: [{ grams: 22_651, quantity: 1 }] }))).body.rates).toEqual([]);
    expect((await rates(rateRequest({ items: [{ grams: 11_001, quantity: 3 }] }))).body.rates).toEqual([]);
  });

  it("acepta hasta los límites de Uber: 22,65 kg por producto y 33 kg en total", async () => {
    expect((await rates(rateRequest({ items: [{ grams: 22_650, quantity: 1 }] }))).body.rates).toHaveLength(1);
    expect((await rates(rateRequest({ items: [{ grams: 11_000, quantity: 3 }] }))).body.rates).toHaveLength(1);
  });

  it("los productos que no requieren envío no cuentan", async () => {
    const items = [{ grams: 0, quantity: 1, requires_shipping: false }, { grams: 1000, quantity: 1 }];
    expect((await rates(rateRequest({ items }))).body.rates).toHaveLength(1);
  });

  it("tienda sin cuenta de Uber conectada: no aparece", async () => {
    db.storeConfig.findUnique.mockResolvedValue({ ...store, uberClientId: null });
    expect((await rates(rateRequest())).body.rates).toEqual([]);
  });

  it("si Uber no cubre la dirección, no aparece (sin romper el checkout)", async () => {
    uber.getDeliveryQuote.mockRejectedValue(new UberApiError("fuera de cobertura", 400, '{"code":"address_undeliverable"}'));
    const { status, body } = await rates(rateRequest());
    expect(status).toBe(200);
    expect(body.rates).toEqual([]);
  });

  it("repite la cotización desde el cache para la misma dirección", async () => {
    const destination = { address1: "Los Leones 100", city: "Providencia" };
    await rates(rateRequest({ destination }));
    await rates(rateRequest({ destination }));
    expect(uber.getDeliveryQuote).toHaveBeenCalledTimes(1);
  });
});
