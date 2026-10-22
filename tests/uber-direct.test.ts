import { beforeEach, describe, expect, it, vi } from "vitest";

// Lo que Fium le manda a Uber al crear un envío. Se simula la DB (token guardado) y la red.
const db = vi.hoisted(() => ({ uberToken: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: db }));

import { createDelivery, describeUberError, UberApiError, type CreateDeliveryRequest } from "../app/services/uber-direct.server";

const creds = { clientId: "client-1", clientSecret: "secret", customerId: "cust-1" };
const req: CreateDeliveryRequest = {
  quoteId: "dqt_1",
  pickupName: "Tienda", pickupAddress: { streetAddress: ["Av. Providencia 1234"], city: "Providencia", state: "RM", zipCode: "7500000" }, pickupPhone: "+56911111111",
  dropoffName: "Camila", dropoffAddress: { streetAddress: ["Av. Grecia 2150"], city: "Ñuñoa", state: "RM", zipCode: "" }, dropoffPhone: "+56922222222",
  manifestItems: [{ name: "Detergente", quantity: 1, size: "medium", weight: 5000, price: 295300 }],
  manifestTotalValue: 295300,
  externalId: "#1001",
};

const uberResponse = { id: "del_1", status: "pending", fee: 295300, currency: "clp", tracking_url: "https://track", live_mode: false };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db.uberToken.findUnique.mockResolvedValue({ token: "tok", expiresAt: new Date(Date.now() + 86_400_000) });
  fetchMock = vi.fn(async () => new Response(JSON.stringify(uberResponse), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

function sentBody() {
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.uber.com/v1/customers/cust-1/deliveries");
  expect(init.headers.Authorization).toBe("Bearer tok");
  return JSON.parse(init.body);
}

describe("createDelivery", () => {
  it("manda direcciones como JSON en texto (formato de Uber), productos y valor total", async () => {
    const result = await createDelivery(creds, req);
    const body = sentBody();
    expect(JSON.parse(body.pickup_address)).toMatchObject({ street_address: ["Av. Providencia 1234"], city: "Providencia", country: "CL" });
    expect(body.manifest_items[0]).toMatchObject({ name: "Detergente", weight: 5000, price: 295300, size: "medium" });
    expect(body.manifest_total_value).toBe(295300);
    expect(body.external_id).toBe("#1001");
    expect(result).toMatchObject({ id: "del_1", trackingUrl: "https://track", fee: 295300 });
  });

  it("en una tienda real NO manda nada del modo prueba", async () => {
    await createDelivery(creds, req);
    const body = sentBody();
    expect(body.test_specifications).toBeUndefined();
    expect(body.undeliverable_action).toBeUndefined();
  });

  it("modo prueba: robo-courier con el escenario elegido", async () => {
    await createDelivery(creds, { ...req, testMode: true, testScenario: "customer_unavailable", undeliverableAction: "leave_at_door" });
    const body = sentBody();
    expect(body.test_specifications).toEqual({ robo_courier_specification: { mode: "auto", cancel_reason: "customer_unavailable" } });
    expect(body.undeliverable_action).toBe("leave_at_door");
  });

  it("modo prueba sin escenario = entrega rápida", async () => {
    await createDelivery(creds, { ...req, testMode: true });
    expect(sentBody().test_specifications).toEqual({ robo_courier_specification: { mode: "auto" } });
  });

  it("si Uber rechaza, lanza UberApiError con un mensaje entendible", async () => {
    fetchMock.mockResolvedValue(new Response('{"code":"address_undeliverable"}', { status: 400 }));
    const err = await createDelivery(creds, req).catch((e) => e);
    expect(err).toBeInstanceOf(UberApiError);
    expect(describeUberError(err)).toBe("Uber Direct no pudo ubicar o entregar en esa dirección.");
  });
});
