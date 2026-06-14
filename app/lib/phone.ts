/**
 * Normaliza un teléfono chileno al formato E.164 (+569XXXXXXXX) que exige Uber.
 * Devuelve null si no logra interpretarlo.
 */
export function normalizeChileanPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  // Ya tiene código de país (56...)
  if (digits.startsWith("56") && digits.length >= 11) return `+${digits}`;
  // Empieza con 0 (056...)
  if (digits.startsWith("0") && digits.length >= 10) return `+56${digits.slice(1)}`;
  // Solo el número local (9 dígitos empezando en 9)
  if (digits.length === 9 && digits.startsWith("9")) return `+56${digits}`;
  // 8 dígitos — número sin el 9 inicial (raro pero posible)
  if (digits.length === 8) return `+569${digits}`;
  return null;
}
