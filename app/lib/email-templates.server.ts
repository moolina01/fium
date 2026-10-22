// Plantillas de los correos de aviso a la tienda. Diseño sobrio: fondo blanco,
// líneas finas, sin íconos; el color solo marca la etiqueta de estado y el botón.
// HTML con tablas y estilos en línea (lo único que respetan Gmail y Outlook) +
// versión en texto plano. Colores de app/lib/theme.ts.
import { colors as C } from "./theme";

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const LINE = C.border;

export type EmailItem = { quantity: number; title: string; amount: number | null };

export type EmailContent = {
  storeName: string;
  label: string;                        // "Acción requerida", "Nuevo pedido"…
  urgent?: boolean;                     // Etiqueta en rojo
  title: string;
  intro: string;
  notice?: { heading: string; body: string }; // Motivo de la cancelación
  details: Array<[string, string]>;     // Filas etiqueta / valor
  items?: EmailItem[];
  totals?: Array<[string, string]>;     // Bajo los productos
  primary: { label: string; url: string };
  secondary?: { label: string; url: string };
  footer: string;
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const nl2br = (s: string) => esc(s).replace(/\n/g, "<br>");

/** 12990 → "$12.990" */
export function clp(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CL")}`;
}

function sectionTitle(t: string): string {
  return `<p style="margin:28px 0 8px;font-size:11px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:${C.muted};">${esc(t)}</p>`;
}

function rows(pairs: Array<[string, string]>, bold = false): string {
  return pairs
    .map(([k, v]) => `
      <tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.muted};width:150px;vertical-align:top;">${esc(k)}</td>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.text};${bold ? "font-weight:600;" : ""}vertical-align:top;">${nl2br(v)}</td>
      </tr>`)
    .join("");
}

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const items = c.items?.length
    ? sectionTitle("Productos") + `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        ${c.items.map((i) => `
        <tr>
          <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.muted};width:44px;vertical-align:top;">${i.quantity} x</td>
          <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.text};vertical-align:top;">${esc(i.title)}</td>
          <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.text};white-space:nowrap;vertical-align:top;">${i.amount != null ? clp(i.amount) : ""}</td>
        </tr>`).join("")}
        ${(c.totals ?? []).map(([k, v]) => `
        <tr>
          <td colspan="2" style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.muted};">${esc(k)}</td>
          <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${C.text};font-weight:600;white-space:nowrap;">${esc(v)}</td>
        </tr>`).join("")}
      </table>`
    : "";

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title></head>
<body style="margin:0;padding:0;background:#F4F4F6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F4F6;font-family:${FONT};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#FFFFFF;border:1px solid ${LINE};border-radius:8px;">
    <tr><td style="padding:22px 32px;border-bottom:1px solid ${LINE};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:17px;font-weight:700;color:${C.ink};letter-spacing:-0.2px;">fium</td>
        <td align="right" style="font-size:13px;color:${C.muted};">${esc(c.storeName)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:32px 32px 8px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:${c.urgent ? C.danger : C.brand};">${esc(c.label)}</p>
      <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${C.ink};">${esc(c.title)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.6;color:${C.text};">${nl2br(c.intro)}</p>
      ${c.notice ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;"><tr>
        <td style="padding:14px 16px;border:1px solid ${LINE};border-left:3px solid ${C.danger};border-radius:4px;">
          <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:${C.text};">${esc(c.notice.heading)}</p>
          <p style="margin:0;font-size:14px;line-height:1.5;color:${C.text};">${esc(c.notice.body)}</p>
        </td>
      </tr></table>` : ""}
      ${sectionTitle("Detalle del pedido")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows(c.details)}</table>
      ${items}
    </td></tr>
    <tr><td style="padding:28px 32px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.brand};border-radius:6px;">
        <a href="${esc(c.primary.url)}" style="display:inline-block;padding:12px 22px;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none;">${esc(c.primary.label)}</a>
      </td></tr></table>
      ${c.secondary ? `<p style="margin:16px 0 0;font-size:14px;"><a href="${esc(c.secondary.url)}" style="color:${C.brand};text-decoration:underline;">${esc(c.secondary.label)}</a></p>` : ""}
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;"><tr>
    <td style="padding:18px 32px 0;font-size:12px;line-height:1.6;color:${C.muted};">
      ${esc(c.footer)} Puedes cambiar qué avisos recibes en Fium, en Configuración, Avisos por correo.
    </td>
  </tr></table>
</td></tr>
</table>
</body></html>`;

  const text = [
    c.label.toUpperCase(),
    c.title,
    "",
    c.intro,
    ...(c.notice ? ["", `${c.notice.heading}: ${c.notice.body}`] : []),
    "",
    "DETALLE DEL PEDIDO",
    ...c.details.map(([k, v]) => `${k}: ${v.replace(/\n/g, ", ")}`),
    ...(c.items?.length
      ? ["", "PRODUCTOS", ...c.items.map((i) => `${i.quantity} x ${i.title}${i.amount != null ? `  ${clp(i.amount)}` : ""}`), ...(c.totals ?? []).map(([k, v]) => `${k}: ${v}`)]
      : []),
    "",
    `${c.primary.label}: ${c.primary.url}`,
    ...(c.secondary ? [`${c.secondary.label}: ${c.secondary.url}`] : []),
    "",
    "--",
    `${c.footer} Puedes cambiar qué avisos recibes en Fium, en Configuración, Avisos por correo.`,
  ].join("\n");

  return { html, text };
}
