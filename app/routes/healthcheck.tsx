import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * Endpoint de salud para el hosting (health probes / load balancer).
 * Devuelve 200 si la app responde y la base de datos contesta; 503 si la DB falla.
 * No requiere autenticación: no expone datos, solo el estado.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // HEAD/GET liviano: confirma conectividad real a la base de datos.
  void request;
  try {
    await db.$queryRaw`SELECT 1`;
    return new Response("OK", { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("DB unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
};
