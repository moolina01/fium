// Precio que paga el cliente por Fium Express en el checkout. Por defecto es el
// precio de Uber; con "envío gratis desde $X" el cliente paga $0 y la tienda
// absorbe lo que cobra Uber. Puro: lo usan el checkout y Configuración.

/** "$34.000", "34000" o "34.000" → 34000. Vacío o inválido → null (sin envío gratis). */
export function parseClpAmount(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[$\s.]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const amount = Number(digits);
  return amount > 0 ? amount : null;
}

/** Subtotal del carrito en pesos. Shopify manda el precio por unidad ×100 en rate.items. */
export function cartSubtotalPesos(items: Array<{ price?: number; quantity?: number }>): number {
  return items.reduce((sum, i) => sum + (i.price ?? 0) * (i.quantity ?? 1), 0) / 100;
}

export function isFreeShipping(subtotalPesos: number, freeShippingFrom: number | null | undefined): boolean {
  return !!freeShippingFrom && subtotalPesos >= freeShippingFrom;
}

/** 34000 → "$34.000" */
export function formatPesos(amount: number): string {
  return `$${Math.round(amount).toLocaleString("es-CL")}`;
}
