// Formato básico de correo, compartido entre cliente y servidor (sin deps de servidor).
export function isEmailFormat(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}
