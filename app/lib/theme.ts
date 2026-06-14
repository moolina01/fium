/**
 * Tokens de diseño de Fium — fuente única de verdad para tipografías y colores.
 * Antes cada ruta redefinía su propia paleta (`F`) y repetía el fontFamily en
 * cada estilo inline; ahora todo importa desde aquí.
 *
 * Pura (sin deps de servidor) para poder usarse en componentes de cliente.
 */

export const FONT = "'Plus Jakarta Sans', Inter, system-ui, sans-serif";
export const DISPLAY_FONT = "'Sora', sans-serif";

export const colors = {
  brand: "#4B2BE0",
  brandHover: "#3A1FB5",
  brandTint: "#EEEDFE",
  ink: "#241266",
  accent: "#C9F03C",
  text: "#1C1633",
  muted: "#6E6B85",
  onDark: "#EDEBFA",
  bg: "#F6F5FB",
  surface: "#FFFFFF",
  border: "#E4E2F0",
  success: "#1D9E75",
  successTint: "#E6F7F2",
  warning: "#EF9F27",
  warningTint: "#FEF9EC",
  danger: "#E24B4A",
  dangerTint: "#FEF2F2",
} as const;
