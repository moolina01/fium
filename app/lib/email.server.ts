// Envío de correos con Resend (https://resend.com/docs/api-reference/emails/send-email).
// Sin dependencias: una llamada HTTP. Nunca lanza: un correo que no sale se deja
// en el log y el flujo que lo pidió (webhook, despacho) sigue normal.
//
// Variables de entorno:
//   RESEND_API_KEY  — clave de Resend. Sin ella no se envía nada (solo se loguea).
//   EMAIL_FROM      — remitente, en un dominio verificado en Resend.
import { logError, logInfo } from "./logger.server";

const DEFAULT_FROM = "Fium <avisos@rockagency.cl>";

export type Email = {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Evita duplicados si el mismo aviso se pide dos veces (Resend lo respeta 24 h).
  idempotencyKey?: string;
};

export async function sendEmail(email: Email, context: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logInfo(context, "RESEND_API_KEY no configurada; correo no enviado", { to: email.to, subject: email.subject });
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(email.idempotencyKey && { "Idempotency-Key": email.idempotencyKey.slice(0, 256) }),
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || DEFAULT_FROM,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
    });
    if (!res.ok) {
      logError(context, new Error(`Resend respondió ${res.status}`), { to: email.to, body: (await res.text()).slice(0, 500) });
      return false;
    }
    return true;
  } catch (err) {
    logError(context, err, { to: email.to });
    return false;
  }
}

/** Validación simple de formato; Resend rechaza el resto. */
export function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}
