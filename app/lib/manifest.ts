// Lista de productos ("manifest") que se le manda a Uber al crear el envío.
// Uber la usa para elegir el vehículo y se la muestra al conductor, así que va
// lo más completa posible: nombre, cantidad, tamaño, peso y precio de cada producto.
import type { ManifestItem } from "../services/uber-direct.server";
import type { PackageSize } from "./package-size";

export type ManifestLine = {
  title: string;
  quantity: number;
  grams: number;     // Peso por unidad (0 si no se conoce)
  unitPrice: number; // Precio por unidad en pesos
};

// Uber expresa los montos ×100 (igual que el fee de las cotizaciones).
const toUberAmount = (pesos: number) => Math.round(pesos * 100);

export function buildManifest(
  lines: ManifestLine[],
  size: PackageSize
): { items: ManifestItem[]; totalValue: number } {
  const items: ManifestItem[] = lines
    .filter((l) => l.quantity > 0)
    .map((l) => ({
      name: l.title.slice(0, 200),
      quantity: l.quantity,
      size,
      ...(l.grams > 0 && { weight: Math.round(l.grams) }),
      ...(l.unitPrice > 0 && { price: toUberAmount(l.unitPrice) }),
    }));
  const totalValue = toUberAmount(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
  return { items, totalValue };
}

/** Lee las líneas guardadas en OrderManifest.items (JSON), descartando lo inválido. */
export function parseManifestLines(json: unknown): ManifestLine[] | null {
  if (!Array.isArray(json)) return null;
  const lines = json
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({
      title: String(l.title ?? ""),
      quantity: Number(l.quantity) || 0,
      grams: Number(l.grams) || 0,
      unitPrice: Number(l.unitPrice) || 0,
    }))
    .filter((l) => l.title && l.quantity > 0);
  return lines.length > 0 ? lines : null;
}
