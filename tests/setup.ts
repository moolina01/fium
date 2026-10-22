// El .env local apunta a la base de datos de PRODUCCIÓN. Las pruebas reemplazan
// db.server con mocks, y por si alguna se olvida, la URL apunta a un servidor
// que no existe: ninguna prueba puede leer ni escribir datos reales.
process.env.DATABASE_URL = "postgresql://tests:tests@127.0.0.1:1/no-db-in-tests";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.ENCRYPTION_KEY = "0".repeat(64);
delete process.env.RESEND_API_KEY;

// Los logs de la app (JSON) ensucian la salida de las pruebas; se silencian.
import { beforeEach, vi } from "vitest";
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
