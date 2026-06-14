// Tamaños de paquete que acepta Uber Direct, con etiquetas legibles en español.
// Se usan tanto en Configuración (default por tienda) como por orden al despachar.

export type PackageSize = "small" | "medium" | "large" | "xlarge";

export const PACKAGE_SIZES: { value: PackageSize; label: string; hint: string }[] = [
  { value: "small", label: "Pequeño", hint: "Sobre, accesorios, joyería" },
  { value: "medium", label: "Mediano", hint: "Caja de zapatos, ropa" },
  { value: "large", label: "Grande", hint: "Caja mediana, varios productos" },
  { value: "xlarge", label: "Extra grande", hint: "Bulto, electrodoméstico pequeño" },
];

const VALID = new Set(PACKAGE_SIZES.map((s) => s.value));

/** Normaliza un valor arbitrario a un PackageSize válido (default: small). */
export function toPackageSize(value: unknown): PackageSize {
  return typeof value === "string" && VALID.has(value as PackageSize)
    ? (value as PackageSize)
    : "small";
}

export function packageSizeLabel(value: string): string {
  return PACKAGE_SIZES.find((s) => s.value === value)?.label ?? "Pequeño";
}
