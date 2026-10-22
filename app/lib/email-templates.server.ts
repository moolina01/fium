// Plantillas de los correos de aviso a la tienda. HTML con tablas y estilos en
// línea (lo único que respetan Gmail y Outlook) + versión en texto plano.
// Colores de app/lib/theme.ts; los correos van siempre en claro.
import { colors as C } from "./theme";

const FONT = "'Plus Jakarta Sans', Helvetica, Arial, sans-serif";

export type Tone = "danger" | "brand" | "warning";

const TONES: Record<Tone, { bg: string; fg: string }> = {
  danger: { bg: C.dangerTint, fg: "#B42318" },
  brand: { bg: C.brandTint, fg: C.brand },
  warning: { bg: C.warningTint, fg: "#92400E" },
};

export type EmailContent = {
  storeName: string;
  tone: Tone;
  banner: string;           // "Requiere tu atención"
  title: string;
  intro: string;            // Texto plano (se escapa)
  callout?: string;         // Recuadro rojo (motivo de la cancelación)
  facts: Array<[string, string]>;
  cta: { label: string; url: string };
  footer: string;           // Por qué recibe el correo
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const nl2br = (s: string) => esc(s).replace(/\n/g, "<br>");

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const tone = TONES[c.tone];
  const facts = c.facts
    .map(([k, v], i) => `
      <tr>
        <td style="padding:10px 14px;${i ? `border-top:1px solid ${C.border};` : ""}font-size:13px;color:${C.muted};width:120px;vertical-align:top;">${esc(k)}</td>
        <td style="padding:10px 14px;${i ? `border-top:1px solid ${C.border};` : ""}font-size:13px;color:${C.text};font-weight:600;">${nl2br(v)}</td>
      </tr>`)
    .join("");

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 12px;font-family:${FONT};">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${C.surface};border:1px solid ${C.border};border-radius:12px;">
    <tr><td style="padding:18px 24px;border-bottom:1px solid ${C.border};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:20px;font-weight:700;color:${C.ink};letter-spacing:-0.3px;">fium</td>
        <td align="right" style="font-size:12px;color:${C.muted};">${esc(c.storeName)}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:11px 24px;background:${tone.bg};color:${tone.fg};font-size:13px;font-weight:600;">${esc(c.banner)}</td></tr>
    <tr><td style="padding:24px;">
      <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:${C.ink};">${esc(c.title)}</h1>
      ${c.callout ? `<div style="margin:0 0 14px;padding:12px 14px;background:${C.dangerTint};border-radius:8px;font-size:14px;color:#8A1C1C;">${esc(c.callout)}</div>` : ""}
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${C.text};">${nl2br(c.intro)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-radius:10px;border-collapse:separate;margin:0 0 20px;">${facts}</table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:${C.brand};border-radius:9px;">
        <a href="${esc(c.cta.url)}" style="display:block;padding:14px;color:#FFFFFF;font-size:15px;font-weight:700;text-decoration:none;">${esc(c.cta.label)} →</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:16px 24px 20px;border-top:1px solid ${C.border};font-size:12px;line-height:1.5;color:${C.muted};">
      ${esc(c.footer)}<br>Cámbialo en Fium → Configuración → Avisos por correo.
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  const text = [
    c.title,
    "",
    ...(c.callout ? [c.callout, ""] : []),
    c.intro,
    "",
    ...c.facts.map(([k, v]) => `${k}: ${v.replace(/\n/g, ", ")}`),
    "",
    `${c.cta.label}: ${c.cta.url}`,
    "",
    "—",
    c.footer,
    "Cámbialo en Fium → Configuración → Avisos por correo.",
  ].join("\n");

  return { html, text };
}
