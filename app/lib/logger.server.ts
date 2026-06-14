/**
 * Logging centralizado de errores.
 *
 * Hoy escribe logs estructurados a la consola. Cuando subas a producción y
 * quieras monitoreo real (alertas, stack traces agregados), enchufa Sentry aquí:
 *
 *   1. npm i @sentry/node
 *   2. Inicializa Sentry en app/entry.server.tsx con process.env.SENTRY_DSN
 *   3. Descomenta la línea Sentry.captureException de abajo.
 *
 * El resto de la app ya llama logError() en sus catch, así que no hay que tocar
 * nada más el día que actives Sentry.
 */

type LogContext = string;

export function logError(context: LogContext, error: unknown, extra?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(
    JSON.stringify({
      level: "error",
      context,
      message,
      ...(extra ? { extra } : {}),
      ...(stack ? { stack } : {}),
      timestamp: new Date().toISOString(),
    })
  );

  // TODO(producción): reenviar a Sentry cuando esté configurado.
  // Sentry.captureException(error, { tags: { context }, extra });
}

export function logInfo(context: LogContext, message: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level: "info",
      context,
      message,
      ...(extra ? { extra } : {}),
      timestamp: new Date().toISOString(),
    })
  );
}

/** Log de diagnóstico — silencioso en producción para no ensuciar los logs. */
export function logDebug(context: LogContext, message: string, extra?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  console.log(
    JSON.stringify({
      level: "debug",
      context,
      message,
      ...(extra ? { extra } : {}),
      timestamp: new Date().toISOString(),
    })
  );
}
