import { defineConfig } from "vitest/config";

// Config propia de las pruebas: sin los plugins de React Router/Shopify de vite.config.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Igual que el servidor en Railway: el horario de despacho no debe depender
    // de la zona horaria de la máquina.
    env: { TZ: "UTC" },
    restoreMocks: true,
  },
});
