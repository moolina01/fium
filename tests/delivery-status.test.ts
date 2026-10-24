import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ delivery: { update: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: db }));
vi.mock("../app/shopify.server", () => ({ unauthenticated: { admin: vi.fn(async () => ({ admin: {} })) } }));
const fulfillment = vi.hoisted(() => ({ addFulfillmentEvent: vi.fn(), cancelOrderFulfillments: vi.fn() }));
vi.mock("../app/lib/fulfillment.server", () => fulfillment);
const notify = vi.hoisted(() => ({ notifyDeliveryProblem: vi.fn() }));
vi.mock("../app/lib/notifications.server", () => notify);

import { applyUberStatus, reopenReturnedDelivery, describeIssueReason, describeVehicle, uberCanceledReason, uberReturnedReason, UBER_CANCELED_REASON } from "../app/lib/delivery-status.server";

const delivery = { id: "d1", shop: "s.myshopify.com", orderId: "gid://shopify/Order/1", orderNumber: "#1001", status: "pickup" };

beforeEach(() => {
  vi.clearAllMocks();
  db.delivery.updateMany.mockResolvedValue({ count: 1 });
});

describe("motivos de Uber en español", () => {
  it.each([
    ["customer_unavailable", "el cliente no estaba disponible o no contestó"],
    ["customer_rejected_order", "el cliente rechazó el pedido"],
    ["cannot_find_customer_address", "el conductor no encontró la dirección del cliente"],
    ["cannot_access_customer_location", "el conductor no pudo llegar a la dirección"],
    ["no_couriers_available", "no había conductores disponibles"],
  ])("%s", (code, es) => {
    expect(describeIssueReason(code)).toBe(es);
  });

  it("un código desconocido se muestra legible", () => {
    expect(describeIssueReason("item_too_hot")).toBe("item too hot");
    expect(describeIssueReason(null)).toBeNull();
  });

  it("textos de cancelado y devuelto", () => {
    expect(uberCanceledReason("customer_unavailable")).toBe("Uber Direct canceló el envío: el cliente no estaba disponible o no contestó. Vuelve a despacharlo.");
    expect(uberCanceledReason(null)).toBe(UBER_CANCELED_REASON);
    expect(uberReturnedReason(null)).toBe("El conductor no pudo entregar el pedido y lo trae de vuelta a tu tienda.");
  });

  it("vehículo del conductor en español", () => {
    expect(describeVehicle({ name: "J", phone: "", vehicleType: "car", vehicleMake: "Toyota", vehicleModel: "Prius", vehicleColor: "White" })).toBe("Toyota Prius blanco");
    expect(describeVehicle({ name: "J", phone: "", vehicleType: "motorcycle" })).toBe("Moto");
  });
});

describe("applyUberStatus", () => {
  it("cancelación de Uber: el pedido vuelve a Por despachar, se cancela el fulfillment y se avisa una vez", async () => {
    const status = await applyUberStatus(delivery, { status: "canceled", issueReason: "customer_unavailable" }, "test");
    expect(status).toBe("failed");
    expect(db.delivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "d1", status: { notIn: ["failed", "canceled"] } },
      data: expect.objectContaining({ status: "failed" }),
    }));
    expect(fulfillment.cancelOrderFulfillments).toHaveBeenCalledTimes(1);
    expect(notify.notifyDeliveryProblem).toHaveBeenCalledWith("d1", "canceled", "el cliente no estaba disponible o no contestó");
  });

  it("si el webhook y el panel ven la misma cancelación, el segundo no repite correo ni cancelación", async () => {
    db.delivery.updateMany.mockResolvedValue({ count: 0 });
    await applyUberStatus(delivery, { status: "canceled" }, "test");
    expect(notify.notifyDeliveryProblem).not.toHaveBeenCalled();
    expect(fulfillment.cancelOrderFulfillments).not.toHaveBeenCalled();
  });

  it("un envío ya cancelado por la tienda no se toca", async () => {
    await applyUberStatus({ ...delivery, status: "canceled" }, { status: "canceled" }, "test");
    expect(db.delivery.updateMany).not.toHaveBeenCalled();
    expect(notify.notifyDeliveryProblem).not.toHaveBeenCalled();
  });

  it("devuelto: guarda el motivo y avisa a la tienda", async () => {
    const status = await applyUberStatus(delivery, { status: "returned", issueReason: "customer_rejected_order" }, "test");
    expect(status).toBe("returned");
    expect(db.delivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "returned", failureReason: expect.stringContaining("el cliente rechazó el pedido") }),
    }));
    expect(notify.notifyDeliveryProblem).toHaveBeenCalledWith("d1", "returned", "el cliente rechazó el pedido");
  });

  it("entregado: agrega el evento en Shopify, sin correo", async () => {
    await applyUberStatus(delivery, { status: "delivered" }, "test");
    expect(fulfillment.addFulfillmentEvent).toHaveBeenCalledWith({}, delivery.orderId, "DELIVERED", "test/fulfillment-event");
    expect(notify.notifyDeliveryProblem).not.toHaveBeenCalled();
  });

  it("mismo estado: solo actualiza ETA y conductor", async () => {
    await applyUberStatus(delivery, { status: "pickup", courier: { name: "Ana", phone: "+569", vehicleType: "car" } }, "test");
    expect(db.delivery.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ courierName: "Ana", courierVehicle: "Auto" }) }));
    expect(db.delivery.updateMany).not.toHaveBeenCalled();
  });
});

describe("reenviar un pedido devuelto", () => {
  const admin = {} as never;

  it("reabre el pedido en Shopify y lo deja listo para despachar de nuevo", async () => {
    db.delivery.findFirst.mockResolvedValue({ ...delivery, status: "returned" });
    fulfillment.cancelOrderFulfillments.mockResolvedValue(true);
    expect(await reopenReturnedDelivery(admin, delivery.shop, "d1")).toEqual({ orderId: "1" });
    expect(fulfillment.cancelOrderFulfillments).toHaveBeenCalledWith(admin, delivery.orderId, expect.any(String));
    expect(db.delivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "d1", status: "returned" },
      data: expect.objectContaining({ status: "failed" }),
    }));
  });

  it("si Shopify no reabre el pedido, no cambia nada", async () => {
    db.delivery.findFirst.mockResolvedValue({ ...delivery, status: "returned" });
    fulfillment.cancelOrderFulfillments.mockResolvedValue(false);
    expect(await reopenReturnedDelivery(admin, delivery.shop, "d1")).toHaveProperty("error");
    expect(db.delivery.updateMany).not.toHaveBeenCalled();
  });

  it("solo envíos devueltos de la misma tienda", async () => {
    db.delivery.findFirst.mockResolvedValue(null);
    expect(await reopenReturnedDelivery(admin, "otra.myshopify.com", "d1")).toHaveProperty("error");
    expect(db.delivery.findFirst).toHaveBeenCalledWith({ where: { id: "d1", shop: "otra.myshopify.com", status: "returned" } });
    expect(fulfillment.cancelOrderFulfillments).not.toHaveBeenCalled();
  });
});
