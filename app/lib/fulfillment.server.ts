import { logError, logInfo } from "./logger.server";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> }
  ) => Promise<Response>;
};

/**
 * Marca la orden de Shopify como "fulfilled" con el tracking de Uber Direct.
 *
 * Esto saca la orden de "Por gestionar" en el admin de Shopify y dispara el
 * email de envío al cliente con el link de seguimiento. Lo usan tanto el
 * despacho manual como el automático.
 *
 * Requiere el scope write_fulfillments. Nunca lanza: si algo falla, lo registra
 * y devuelve false, para no romper el flujo de creación del envío (que ya
 * sucedió en Uber).
 *
 * Nota: fulfillmentCreateV2 está deprecada en 2025-10 (reemplazo futuro:
 * fulfillmentCreate) pero sigue disponible y funcionando.
 */
export async function fulfillOrderWithTracking(
  admin: AdminGraphql,
  orderGid: string,
  trackingUrl: string | null,
  context: string
): Promise<boolean> {
  try {
    const foRes = await admin.graphql(
      `#graphql
      query GetFulfillmentOrders($id: ID!) {
        order(id: $id) {
          fulfillmentOrders(first: 10) {
            edges { node { id status } }
          }
        }
      }`,
      { variables: { id: orderGid } }
    );
    const foJson = await foRes.json();
    const edges = foJson.data?.order?.fulfillmentOrders?.edges ?? [];

    // Solo se pueden cumplir las fulfillment orders en estado abierto.
    const fulfillable = edges
      .filter((e: { node: { status: string } }) =>
        ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(e.node.status)
      )
      .map((e: { node: { id: string } }) => ({ fulfillmentOrderId: e.node.id }));

    if (fulfillable.length === 0) {
      logInfo(context, "orden sin fulfillment orders abiertas — no se marca fulfilled", { orderGid });
      return false;
    }

    const res = await admin.graphql(
      `#graphql
      mutation FulfillOrder($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          fulfillment: {
            lineItemsByFulfillmentOrder: fulfillable,
            ...(trackingUrl ? { trackingInfo: { url: trackingUrl, company: "Uber Direct" } } : {}),
            notifyCustomer: true,
          },
        },
      }
    );
    const json = await res.json();
    const userErrors = json.data?.fulfillmentCreateV2?.userErrors ?? [];
    if (userErrors.length > 0) {
      logError(context, "fulfillmentCreateV2 devolvió userErrors", { orderGid, userErrors });
      return false;
    }
    return true;
  } catch (e) {
    logError(context, e, { orderGid });
    return false;
  }
}

export type FulfillmentEventStatus = "IN_TRANSIT" | "OUT_FOR_DELIVERY" | "DELIVERED";

/**
 * Agrega un evento a la fulfillment de la orden (ej: "Entregado"), para que la
 * línea de tiempo del pedido en Shopify refleje el avance real del envío de Uber.
 * Requiere que la orden ya esté fulfilled. No lanza: registra y devuelve false.
 */
export async function addFulfillmentEvent(
  admin: AdminGraphql,
  orderGid: string,
  status: FulfillmentEventStatus,
  context: string
): Promise<boolean> {
  try {
    const res = await admin.graphql(
      `#graphql
      query GetFulfillments($id: ID!) {
        order(id: $id) {
          fulfillments(first: 1) { id status }
        }
      }`,
      { variables: { id: orderGid } }
    );
    const json = await res.json();
    const fulfillmentId = json.data?.order?.fulfillments?.[0]?.id;
    if (!fulfillmentId) {
      logInfo(context, "orden sin fulfillment — no se crea evento", { orderGid, status });
      return false;
    }

    const evRes = await admin.graphql(
      `#graphql
      mutation AddFulfillmentEvent($fulfillmentEvent: FulfillmentEventInput!) {
        fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
          fulfillmentEvent { id status }
          userErrors { field message }
        }
      }`,
      { variables: { fulfillmentEvent: { fulfillmentId, status } } }
    );
    const evJson = await evRes.json();
    const userErrors = evJson.data?.fulfillmentEventCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      logError(context, "fulfillmentEventCreate devolvió userErrors", { orderGid, status, userErrors });
      return false;
    }
    return true;
  } catch (e) {
    logError(context, e, { orderGid, status });
    return false;
  }
}
