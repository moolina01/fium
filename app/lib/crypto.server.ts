/**
 * crypto.server.ts — Cifrado simétrico para secretos en reposo (DB).
 *
 * Se usa para guardar el `client_secret` de Uber Direct de cada tienda cifrado
 * en la columna `StoreConfig.uberClientSecret`. Algoritmo: AES-256-GCM.
 *
 * Requiere la variable de entorno:
 *   ENCRYPTION_KEY — 32 bytes en hex (64 caracteres). Genera una con:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Formato del texto cifrado: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12; // GCM recomienda 12 bytes

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("Falta ENCRYPTION_KEY en las variables de entorno (32 bytes en hex)");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY debe ser de 32 bytes (64 caracteres hex)");
  }
  return key;
}

/** Cifra un texto plano. Devuelve "iv:authTag:ciphertext" en hex. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Descifra un texto producido por `encrypt`. Lanza si está corrupto o la llave no coincide. */
export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Texto cifrado con formato inválido");
  }
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
