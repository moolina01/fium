import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getProofOfDelivery, getStoreUberCreds, type ProofType } from "../services/uber-direct.server";
import { logError } from "../lib/logger.server";

/**
 * Devuelve la prueba de entrega de un delivery como data URI (base64) listo
 * para `<img src>`. Se consume on-demand desde el historial del dashboard, así
 * no guardamos imágenes pesadas en la base de datos.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const deliveryId = params.id!;

  const delivery = await db.delivery.findFirst({
    where: { id: deliveryId, shop: session.shop },
  });
  if (!delivery?.uberDeliveryId) {
    return Response.json({ error: "Envío no encontrado." }, { status: 404 });
  }
  if (delivery.status !== "delivered") {
    return Response.json({ error: "La prueba de entrega está disponible solo para envíos entregados." }, { status: 400 });
  }

  const creds = await getStoreUberCreds(session.shop);

  // Probar foto primero, luego firma — el courier captura uno u otro.
  for (const type of ["picture", "signature"] as ProofType[]) {
    try {
      const document = await getProofOfDelivery(creds, delivery.uberDeliveryId, type);
      if (document) {
        // Detectar el mime por el prefijo del base64 (PNG vs JPEG)
        const mime = document.startsWith("iVBOR") ? "image/png" : "image/jpeg";
        return Response.json({ image: `data:${mime};base64,${document}`, kind: type });
      }
    } catch {
      // Ese tipo no fue capturado — probar el siguiente
    }
  }

  logError("deliveries/proof", "sin prueba de entrega disponible", { deliveryId });
  return Response.json({ error: "Uber Direct no tiene una prueba de entrega para este envío." }, { status: 404 });
};
