// Tamaños de paquete que acepta Uber Direct, con etiquetas legibles en español.
// Se usan tanto en Configuración (default por tienda) como por orden al despachar.

export type PackageSize = "small" | "medium" | "large" | "xlarge";

export const PACKAGE_SIZES: {
  value: PackageSize;
  label: string;
  hint: string;
  maxKg: number;            // Tope de peso del tamaño (coincide con SIZE_BY_MAX_GRAMS)
  vehicle: "moto" | "moto-auto" | "auto"; // Vehículo que puede asignar Uber
}[] = [
  { value: "small", label: "Pequeño", hint: "Hasta 2 kg — se lleva con una mano", maxKg: 2, vehicle: "moto" },
  { value: "medium", label: "Mediano", hint: "Hasta 7 kg — cabe en una bolsa", maxKg: 7, vehicle: "moto" },
  { value: "large", label: "Grande", hint: "Hasta 12 kg — se lleva con las dos manos", maxKg: 12, vehicle: "moto-auto" },
  { value: "xlarge", label: "Extra grande", hint: "Hasta 20 kg — Uber asigna siempre auto", maxKg: 20, vehicle: "auto" },
];

// Según la guía de tamaños de Uber Direct, solo "xlarge" exige auto ("Specifying
// extra large items will require a car"); para los demás Uber elige el vehículo.
export const CAR_ONLY_SIZE: PackageSize = "xlarge";

export const VEHICLE_LABEL = { moto: "Moto", "moto-auto": "Moto o auto", auto: "Auto" } as const;

/** Tamaño que se le manda a Uber: con "Siempre auto" activo, siempre Extra grande. */
export function effectiveSize(size: PackageSize, carOnly: boolean): PackageSize {
  return carOnly ? CAR_ONLY_SIZE : size;
}

const VALID = new Set(PACKAGE_SIZES.map((s) => s.value));

/** Normaliza un valor arbitrario a un PackageSize válido (default: medium, para evitar
 * que pedidos con varias unidades/bultos queden subestimados como "small"). */
export function toPackageSize(value: unknown): PackageSize {
  return typeof value === "string" && VALID.has(value as PackageSize)
    ? (value as PackageSize)
    : "medium";
}

export function packageSizeLabel(value: string): string {
  return PACKAGE_SIZES.find((s) => s.value === value)?.label ?? "Mediano";
}

// ─── Peso ───────────────────────────────────────────────────────────────────
// Uber Direct no valida peso ni tamaño al cotizar (cobra por distancia) y deja
// que el courier rechace en el local lo que no puede llevar. Por eso Fium hace
// el control: no se ofrece en el checkout si el pedido excede este peso.
export const MAX_ORDER_WEIGHT_GRAMS = 20_000; // 20 kg

// Tamaño según el peso total del pedido. Cortes conservadores: Uber usa el
// tamaño para elegir el vehículo, y un pedido de varios productos pesados
// (ej. detergentes) no debe asignarse a una moto/bicicleta.
// Moto/bici: mochila de ~50×45×30 cm. Grande/Extra grande → auto.
const SIZE_BY_MAX_GRAMS: Array<[number, PackageSize]> = [
  [2_000, "small"],
  [7_000, "medium"],
  [12_000, "large"],
];

/** Tamaño sugerido para un pedido según su peso total en gramos.
 * Devuelve null si no hay peso (0), para que se use el tamaño por defecto de la tienda. */
export function sizeFromGrams(totalGrams: number): PackageSize | null {
  if (!totalGrams || totalGrams <= 0) return null;
  for (const [max, size] of SIZE_BY_MAX_GRAMS) if (totalGrams <= max) return size;
  return "xlarge";
}

/** Convierte un Weight de la Admin GraphQL API ({ unit, value }) a gramos. */
export function weightToGrams(weight: { unit: string; value: number } | null | undefined): number {
  if (!weight) return 0;
  const factor: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };
  return Math.round(weight.value * (factor[weight.unit] ?? 0));
}

/** "3,2 kg" — formato legible para la UI. */
export function formatKg(grams: number): string {
  return `${(grams / 1000).toLocaleString("es-CL", { maximumFractionDigits: 1 })} kg`;
}
