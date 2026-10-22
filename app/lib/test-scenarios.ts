// Escenarios del simulador de pruebas (robo-courier de Uber, sandbox).
// Solo se ofrecen en las tiendas de app/lib/test-shops.server.ts; en tiendas
// reales nunca se mandan a Uber.
// Docs: https://developer.uber.com/docs/deliveries/guides/robocourier

export type UberCancelReason =
  | "cannot_access_customer_location"
  | "cannot_find_customer_address"
  | "customer_rejected_order"
  | "customer_unavailable";

export type UndeliverableAction = "return" | "leave_at_door";

export type TestScenario = "fast" | "slow" | UberCancelReason;

export const TEST_SCENARIOS: { value: TestScenario; label: string; hint: string }[] = [
  { value: "fast", label: "Entrega normal (rápida)", hint: "Cada etapa avanza cada ~30 segundos" },
  { value: "slow", label: "Entrega normal (lenta)", hint: "Unos 20 minutos, para ver el progreso y la hora de llegada" },
  { value: "customer_unavailable", label: "Cancela: cliente no disponible", hint: "El conductor llega y el cliente no está" },
  { value: "customer_rejected_order", label: "Cancela: cliente rechaza el pedido", hint: "El cliente no recibe el pedido" },
  { value: "cannot_find_customer_address", label: "Cancela: no encuentra la dirección", hint: "El conductor no ubica la dirección" },
  { value: "cannot_access_customer_location", label: "Cancela: no puede acceder", hint: "El conductor no logra entrar (edificio, condominio)" },
];

export const UNDELIVERABLE_ACTIONS: { value: UndeliverableAction; label: string }[] = [
  { value: "return", label: "Devolver a la tienda" },
  { value: "leave_at_door", label: "Dejar en la puerta" },
];

const VALID_SCENARIOS = new Set<string>(TEST_SCENARIOS.map((s) => s.value));

export function toTestScenario(v: unknown): TestScenario {
  return typeof v === "string" && VALID_SCENARIOS.has(v) ? (v as TestScenario) : "fast";
}

export function toUndeliverableAction(v: unknown): UndeliverableAction {
  return v === "leave_at_door" ? "leave_at_door" : "return";
}

export function isCancelScenario(s: TestScenario): s is UberCancelReason {
  return s !== "fast" && s !== "slow";
}

/**
 * `test_specifications.robo_courier_specification` para Uber.
 * - fast: modo auto (~30 s por etapa).
 * - slow: modo custom con horas fijas (Uber exige que enroute sea dentro de
 *   30 min desde el pedido y la entrega dentro de 8 h desde el retiro).
 * - cancelación: modo auto con cancel_reason; el robot cancela al llegar al cliente.
 */
export function roboCourierSpec(scenario: TestScenario, now = new Date()): Record<string, unknown> {
  if (scenario === "slow") {
    const at = (min: number) => new Date(now.getTime() + min * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return {
      mode: "custom",
      enroute_for_pickup_at: at(1),
      pickup_imminent_at: at(5),
      pickup_at: at(7),
      dropoff_imminent_at: at(17),
      dropoff_at: at(20),
    };
  }
  if (isCancelScenario(scenario)) return { mode: "auto", cancel_reason: scenario };
  return { mode: "auto" };
}
