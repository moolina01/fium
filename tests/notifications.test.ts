import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Avisos por correo. Se simulan la DB, Shopify y Resend (sendEmail).
const db = vi.hoisted(() => ({
  storeConfig: { findUnique: vi.fn(), updateMany: vi.fn() },
  orderManifest: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  delivery: { findUnique: vi.fn() },
  dismissedOrder: { findUnique: vi.fn() },
}));
vi.mock("../app/db.server", () => ({ default: db }));
const shopify = vi.hoisted(() => ({ graphql: vi.fn() }));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql: shopify.graphql } })) } }));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("../app/lib/email.server", () => ({ sendEmail: mail.sendEmail }));

import { notifyDeliveryProblem, notifyNewOrder, runReminderSweep } from "../app/lib/notifications.server";

const SHOP = "tienda.myshopify.com";
const config = {
  shop: SHOP, contactName: "Ferretería Los Andes", notifyEmail: "bodega@tienda.cl",
  notifyCanceled: true, notifyNewOrder: true, notifyReminder: true, autoDispatch: false,
  dispatchDays: "1,2,3,4,5,6", dispatchStart: "09:00", dispatchCutoff: "19:00",
};
const manifest = (createdAt: string) => ({
  id: "m1", shop: SHOP, orderId: "gid://shopify/Order/555", orderNumber: "#1013",
  customerName: "Camila Rojas", customerComuna: "Ñuñoa", customerAddress: "Av. Grecia 2150", customerPhone: "+56987654321",
  orderTotal: 14523, orderNote: "Dejar en conserjería", reminderSentAt: null, createdAt: new Date(createdAt),
  items: [{ title: "Detergente 5L", quantity: 1, grams: 5000, unitPrice: 8990 }],
});
const shopifyOrder = (o: object) => ({ json: async () => ({ data: { order: o, shop: { email: "dueno@tienda.cl" } } }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  db.storeConfig.findUnique.mockResolvedValue(config);
  db.orderManifest.updateMany.mockResolvedValue({ count: 1 });
  db.delivery.findUnique.mockResolvedValue(null);
  db.dismissedOrder.findUnique.mockResolvedValue(null);
  shopify.graphql.mockResolvedValue(shopifyOrder({ cancelledAt: null, closed: false, displayFulfillmentStatus: "UNFULFILLED" }));
  mail.sendEmail.mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

const sent = () => mail.sendEmail.mock.calls.map(([email]) => email);

describe("recordatorio de pedido sin despachar", () => {
  it("se manda 20 min después de la compra, con el detalle del pedido", async () => {
    vi.setSystemTime(new Date("2026-10-21T10:25:00-03:00"));
    db.orderManifest.findMany.mockResolvedValue([manifest("2026-10-21T10:00:00-03:00")]);
    await runReminderSweep();
    expect(sent()).toHaveLength(1);
    const email = sent()[0];
    expect(email.to).toBe("bodega@tienda.cl");
    expect(email.subject).toBe("Recordatorio: el pedido #1013 lleva 25 minutos sin despachar");
    expect(email.text).toContain("Entrega prometida: Antes de las 13:00 (1 a 3 horas desde el pago)");
    expect(email.text).toContain("Ver pedido en Shopify: https://tienda.myshopify.com/admin/orders/555");
  });

  it("un pedido de anoche no se recuerda de madrugada, sino 20 min después de abrir", async () => {
    db.orderManifest.findMany.mockResolvedValue([manifest("2026-10-21T23:10:00-03:00")]);
    vi.setSystemTime(new Date("2026-10-22T08:00:00-03:00"));
    await runReminderSweep();
    expect(sent()).toHaveLength(0);
    expect(db.orderManifest.updateMany).not.toHaveBeenCalled(); // queda pendiente para después

    vi.setSystemTime(new Date("2026-10-22T09:21:00-03:00"));
    await runReminderSweep();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].subject).toBe("Recordatorio: el pedido #1013 sigue sin despachar");
  });

  it("no se manda si el pedido ya se despachó, se marcó No gestionar o se envió fuera de Fium", async () => {
    vi.setSystemTime(new Date("2026-10-21T10:25:00-03:00"));
    db.orderManifest.findMany.mockResolvedValue([manifest("2026-10-21T10:00:00-03:00")]);

    db.delivery.findUnique.mockResolvedValueOnce({ id: "d1" });
    await runReminderSweep();
    db.dismissedOrder.findUnique.mockResolvedValueOnce({ id: "x" });
    await runReminderSweep();
    shopify.graphql.mockResolvedValueOnce(shopifyOrder({ cancelledAt: null, closed: false, displayFulfillmentStatus: "FULFILLED" }));
    await runReminderSweep();

    expect(sent()).toHaveLength(0);
  });

  it("no se repite: si otro proceso ya lo reclamó, no manda", async () => {
    vi.setSystemTime(new Date("2026-10-21T10:25:00-03:00"));
    db.orderManifest.findMany.mockResolvedValue([manifest("2026-10-21T10:00:00-03:00")]);
    db.orderManifest.updateMany.mockResolvedValue({ count: 0 });
    await runReminderSweep();
    expect(sent()).toHaveLength(0);
  });

  it("respeta si la tienda apagó los recordatorios o borró el correo", async () => {
    vi.setSystemTime(new Date("2026-10-21T10:25:00-03:00"));
    db.orderManifest.findMany.mockResolvedValue([manifest("2026-10-21T10:00:00-03:00")]);
    db.storeConfig.findUnique.mockResolvedValueOnce({ ...config, notifyReminder: false });
    await runReminderSweep();
    db.storeConfig.findUnique.mockResolvedValueOnce({ ...config, notifyEmail: "" });
    await runReminderSweep();
    expect(sent()).toHaveLength(0);
  });

  it("los pedidos de hace más de 6 h se descartan sin correo", async () => {
    vi.setSystemTime(new Date("2026-10-21T18:00:00-03:00"));
    db.orderManifest.findMany.mockResolvedValue([manifest("2026-10-21T10:00:00-03:00")]);
    await runReminderSweep();
    expect(db.orderManifest.updateMany).toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
  });
});

describe("aviso de envío con problemas", () => {
  const delivery = {
    id: "d1", shop: SHOP, orderId: "gid://shopify/Order/555", orderNumber: "#1012", customerName: "Camila Rojas",
    customerAddress: "Av. Grecia 2150", customerComuna: "Ñuñoa", uberDeliveryId: "del_9", quoteAmount: 2953,
    courierName: "Juan", courierVehicle: "Toyota Prius blanco", createdAt: new Date("2026-10-21T10:05:00-03:00"),
  };

  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-21T10:41:00-03:00"));
    db.delivery.findUnique.mockResolvedValue(delivery);
    db.orderManifest.findUnique.mockResolvedValue(manifest("2026-10-21T10:00:00-03:00"));
  });

  it("cancelación: asunto claro, motivo, conductor, costo y links", async () => {
    await notifyDeliveryProblem("d1", "canceled", "el cliente no estaba disponible o no contestó");
    const email = sent()[0];
    expect(email.subject).toBe("Acción requerida: Uber canceló el envío del pedido #1012");
    expect(email.text).toContain("Motivo informado por Uber: El cliente no estaba disponible o no contestó.");
    expect(email.text).toContain("Conductor: Juan, Toyota Prius blanco");
    expect(email.text).toContain("Costo del envío: $2.953");
    expect(email.text).toContain("Teléfono: +56987654321");
    expect(email.text).toContain("ID de envío en Uber: del_9");
    expect(email.text).toContain("Volver a despachar: https://tienda.myshopify.com/admin/apps/test-api-key/app/orders/555");
    expect(email.idempotencyKey).toBe("canceled:d1:del_9");
  });

  it("devuelto lleva al detalle del envío", async () => {
    await notifyDeliveryProblem("d1", "returned", null);
    expect(sent()[0].subject).toBe("Acción requerida: el pedido #1012 vuelve a tu tienda");
    expect(sent()[0].text).toContain("/app/deliveries/d1");
    // "returned" = el conductor viene de vuelta, todavía no llega.
    expect(sent()[0].text).toContain("viene de vuelta a tu tienda");
    expect(sent()[0].text).toContain("Uber cobra el viaje de vuelta");
  });

  it("no se manda si la tienda apagó estos avisos", async () => {
    db.storeConfig.findUnique.mockResolvedValue({ ...config, notifyCanceled: false });
    await notifyDeliveryProblem("d1", "canceled", null);
    expect(sent()).toHaveLength(0);
  });

  it("tienda que nunca configuró correo: usa el de Shopify y lo guarda", async () => {
    db.storeConfig.findUnique.mockResolvedValue({ ...config, notifyEmail: null });
    db.storeConfig.updateMany.mockResolvedValue({ count: 1 });
    await notifyDeliveryProblem("d1", "canceled", null);
    expect(sent()[0].to).toBe("dueno@tienda.cl");
    expect(db.storeConfig.updateMany).toHaveBeenCalledWith({ where: { shop: SHOP, notifyEmail: null }, data: { notifyEmail: "dueno@tienda.cl" } });
  });

  it("si Resend falla, no rompe el flujo", async () => {
    mail.sendEmail.mockRejectedValue(new Error("Resend caído"));
    await expect(notifyDeliveryProblem("d1", "canceled", null)).resolves.toBeUndefined();
  });
});

describe("aviso de pedido nuevo", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-10-21T10:00:30-03:00"));
    db.orderManifest.findUnique.mockResolvedValue(manifest("2026-10-21T10:00:00-03:00"));
  });

  it("incluye cliente, productos, total y entrega prometida", async () => {
    await notifyNewOrder(SHOP, "gid://shopify/Order/555");
    const email = sent()[0];
    expect(email.subject).toBe("Nuevo pedido #1013 para despachar con Uber");
    for (const t of ["Cliente: Camila Rojas", "Dirección: Av. Grecia 2150, Ñuñoa", "Nota del cliente: Dejar en conserjería", "1 x Detergente 5L  $8.990", "Total pagado por el cliente: $14.523", "Peso total: 5 kg"]) {
      expect(email.text).toContain(t);
    }
  });

  it("apagado por defecto: no se manda si la tienda no lo activó", async () => {
    db.storeConfig.findUnique.mockResolvedValue({ ...config, notifyNewOrder: false });
    await notifyNewOrder(SHOP, "gid://shopify/Order/555");
    expect(sent()).toHaveLength(0);
  });

  it("con despacho automático no se manda", async () => {
    db.storeConfig.findUnique.mockResolvedValue({ ...config, autoDispatch: true });
    await notifyNewOrder(SHOP, "gid://shopify/Order/555");
    expect(sent()).toHaveLength(0);
  });
});
