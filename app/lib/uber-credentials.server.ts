import db from "../db.server";
import { encrypt, decrypt } from "./crypto.server";
import { testUberConnection } from "../services/uber-direct.server";
import { ensureUberWebhookForShop } from "../shopify.server";

/**
 * Valida, cifra y guarda las credenciales de Uber Direct de una tienda. Usada
 * por Settings, Onboarding y el banner del dashboard — una sola implementación
 * para que las 3 superficies validen/guarden exactamente igual.
 */
export async function saveUberCredentials(
  shop: string,
  input: { uberClientId: string; uberCustomerId: string; uberClientSecret: string }
): Promise<{ error: string } | { success: true }> {
  const uberClientId = input.uberClientId.trim();
  const uberCustomerId = input.uberCustomerId.trim();
  const rawSecret = input.uberClientSecret.trim();

  if (!uberClientId || !uberCustomerId) {
    return { error: "Completa el Client ID y el Customer ID." };
  }

  const existing = await db.storeConfig.findUnique({ where: { shop } });
  if (!existing) {
    return { error: "Primero guarda tu punto de despacho." };
  }

  // Si el campo del secret va vacío, conservamos el ya guardado (permite editar
  // Client ID / Customer ID sin volver a pegar el secret).
  let secretPlain = rawSecret;
  if (!secretPlain) {
    if (!existing.uberClientSecret) {
      return { error: "Ingresa el Client Secret de Uber Direct." };
    }
    secretPlain = decrypt(existing.uberClientSecret);
  }

  // Validar contra Uber antes de guardar nada.
  try {
    await testUberConnection({ clientId: uberClientId, clientSecret: secretPlain, customerId: uberCustomerId });
  } catch {
    return { error: "No se pudo conectar con Uber. Revisa el Client ID y el Client Secret." };
  }

  await db.storeConfig.update({
    where: { shop },
    data: { uberClientId, uberClientSecret: encrypt(secretPlain), uberCustomerId },
  });

  // Registrar el webhook de Uber para esta tienda (no bloquea si falla).
  await ensureUberWebhookForShop(shop);

  return { success: true };
}
