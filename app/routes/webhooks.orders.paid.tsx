import { authenticate, unauthenticated } from "../shopify.server";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { getDeliveryQuote, createDelivery } from "../services/uber-direct.server";
import { logError, logInfo } from "../lib/logger.server";
import { checkPlanLimit } from "../lib/plan-limits.server";
import { toPackageSize } from "../lib/package-size";
import { normalizeChileanPhone } from "../lib/phone";
import { fulfillOrderWithTracking } from "../lib/fulfillment.server";

type OrderPayload = {
  id: number;
  name: string;
  note: string | null;
  shipping_lines: Array<{ title: string }>;
  shipping_address: {
    name: string;
    address1: string;
    city: string;
    zip: string;
    phone: string | null;
  } | null;
  billing_address: { phone: string | null } | null;
  line_items: Array<{ title: string; quantity: number }>;
  customer: { phone: string | null; email: string | null } | null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_PAID") return new Response("OK", { status: 200 });

  const order = payload as OrderPayload;

  // Solo procesar órdenes con envío Uber Direct
  const isUberOrder = order.shipping_lines?.some((l) =>
    l.title.toLowerCase().includes("uber")
  );
  if (!isUberOrder) return new Response("OK", { status: 200 });

  const config = await db.storeConfig.findUnique({ where: { shop } });
  if (!config || !order.shipping_address) return new Response("OK", { status: 200 });

  const shopifyOrderId = `gid://shopify/Order/${order.id}`;

  // Evitar duplicados (el índice único shop+orderId es la red de seguridad final)
  const existing = await db.delivery.findUnique({
    where: { shop_orderId: { shop, orderId: shopifyOrderId } },
  });
  if (existing) return new Response("OK", { status: 200 });

  // TEMP(promt02): clientes de prueba sin cobro → el auto-despacho ya no depende
  // del plan, solo de que la tienda lo tenga activado.
  // Revertir cuando se cobre: restaurar la condición original comentada.
  const autoDispatchAllowed = config.autoDispatch;
  // const autoDispatchAllowed =
  //   config.autoDispatch && config.planStatus === "active" && config.plan !== "starter";

  if (!autoDispatchAllowed) {
    // Modo manual: la orden aparece en el dashboard vía Shopify API, sin crear delivery
    return new Response("OK", { status: 200 });
  }

  // Respetar el límite mensual del plan — si se alcanzó, no auto-despachar.
  // La orden queda en "Por despachar" y el merchant decide tras actualizar el plan.
  const { allowed } = await checkPlanLimit(shop);
  if (!allowed) {
    logInfo("orders.paid/limit-reached", "auto-despacho omitido por límite de plan", {
      shop,
      orderNumber: order.name,
    });
    return new Response("OK", { status: 200 });
  }

  // Campos comunes del delivery, sea éxito o fallo
  const baseData = {
    shop,
    orderId: shopifyOrderId,
    orderNumber: order.name,
    customerName: order.shipping_address.name,
    customerAddress: order.shipping_address.address1,
    customerComuna: order.shipping_address.city,
  };

  // 1) Llamar a Uber (puede fallar) — separado del insert para no mezclar errores
  let deliveryData: typeof baseData & {
    uberDeliveryId?: string;
    uberTrackingUrl?: string;
    status: string;
    quoteAmount?: number;
  };
  try {
    const pickupAddress = {
      streetAddress: [config.address],
      city: config.comuna,
      state: config.region,
      zipCode: config.zipCode,
    };
    const dropoffAddress = {
      streetAddress: [order.shipping_address.address1],
      city: order.shipping_address.city,
      state: order.shipping_address.city,
      zipCode: order.shipping_address.zip,
    };

    const quote = await getDeliveryQuote({ pickupAddress, dropoffAddress });

    // Uber no puede ejecutar el envío sin teléfono. Si la orden no trae el del
    // cliente, usamos el teléfono de la tienda como respaldo y lo dejamos trazado.
    const customerPhone =
      normalizeChileanPhone(order.shipping_address.phone) ||
      normalizeChileanPhone(order.customer?.phone) ||
      normalizeChileanPhone(order.billing_address?.phone) ||
      null;
    const dropoffPhone = customerPhone || normalizeChileanPhone(config.phone) || "";
    if (!customerPhone && dropoffPhone) {
      logInfo(
        "orders.paid/phone-fallback",
        "Orden sin teléfono del cliente; se usó el teléfono de la tienda para el envío",
        { shop, orderNumber: order.name }
      );
    }

    const delivery = await createDelivery({
      quoteId: quote.id,
      pickupName: config.contactName,
      pickupAddress,
      pickupPhone: config.phone,
      pickupNotes: config.pickupNotes || undefined,
      dropoffName: order.shipping_address.name,
      dropoffAddress,
      dropoffPhone,
      dropoffNotes: order.note?.trim() || undefined,
      manifestItems: order.line_items.map((i) => ({
        name: i.title,
        quantity: i.quantity,
        size: toPackageSize(config.packageSize),
      })),
    });

    deliveryData = {
      ...baseData,
      uberDeliveryId: delivery.id,
      uberTrackingUrl: delivery.trackingUrl,
      status: delivery.status,
      quoteAmount: quote.fee / 100,
    };
  } catch (err) {
    logError("orders.paid/auto-dispatch", err, { shop, orderNumber: order.name });
    deliveryData = { ...baseData, status: "failed" };
  }

  // 2) Insertar — si otro webhook concurrente ya insertó, ignorar el choque (P2002)
  let inserted = true;
  try {
    await db.delivery.create({ data: deliveryData });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      inserted = false;
      logInfo("orders.paid/duplicate", "delivery ya existía (carrera de webhooks)", {
        shop,
        orderNumber: order.name,
      });
    } else {
      throw e;
    }
  }

  // 3) Marcar fulfilled en Shopify con el tracking de Uber — solo si el envío
  // se creó OK y no fue una reentrega duplicada. Usa el token offline guardado.
  if (inserted && deliveryData.uberDeliveryId) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      await fulfillOrderWithTracking(
        admin,
        shopifyOrderId,
        deliveryData.uberTrackingUrl ?? null,
        "orders.paid/auto-fulfill"
      );
    } catch (err) {
      logError("orders.paid/auto-fulfill", err, { shop, orderNumber: order.name });
    }
  }

  return new Response("OK", { status: 200 });
};
