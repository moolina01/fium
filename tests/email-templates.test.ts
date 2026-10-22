import { describe, expect, it } from "vitest";
import { clp, renderEmail, type EmailContent } from "../app/lib/email-templates.server";

const base: EmailContent = {
  storeName: "Ferretería <Los Andes>",
  label: "Acción requerida",
  urgent: true,
  title: "Uber canceló el envío del pedido #1012",
  intro: "El pedido volvió a Por despachar.",
  notice: { heading: "Motivo informado por Uber", body: "El cliente no estaba disponible." },
  details: [["Pedido", "#1012"], ["Nota del cliente", "Dejar en conserjería\nDepto 304"]],
  items: [{ quantity: 2, title: "Esponja", amount: 2580 }, { quantity: 1, title: "Sin precio", amount: null }],
  totals: [["Total pagado por el cliente", clp(14523)]],
  primary: { label: "Volver a despachar", url: "https://x.myshopify.com/admin/apps/k/app/orders/1?a=1&b=2" },
  secondary: { label: "Ver pedido en Shopify", url: "https://x.myshopify.com/admin/orders/1" },
  footer: "Recibes este correo porque sí.",
};

describe("plantilla de correo", () => {
  it("escapa el HTML de los datos (nombre de tienda, links)", () => {
    const { html } = renderEmail(base);
    expect(html).toContain("Ferretería &lt;Los Andes&gt;");
    expect(html).not.toContain("<Los Andes>");
    expect(html).toContain('href="https://x.myshopify.com/admin/apps/k/app/orders/1?a=1&amp;b=2"');
  });

  it("incluye detalle, productos, total, botón y link a Shopify", () => {
    const { html } = renderEmail(base);
    for (const t of ["#1012", "Dejar en conserjería<br>Depto 304", "2 x", "Esponja", "$2.580", "$14.523", "Volver a despachar", "Ver pedido en Shopify", "Motivo informado por Uber"]) {
      expect(html).toContain(t);
    }
  });

  it("no usa emojis ni flechas", () => {
    const { html, text } = renderEmail(base);
    expect(html + text).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿→]/u);
  });

  it("la versión en texto plano lleva lo mismo", () => {
    const { text } = renderEmail(base);
    expect(text).toContain("Nota del cliente: Dejar en conserjería, Depto 304");
    expect(text).toContain("2 x Esponja  $2.580");
    expect(text).toContain("Ver pedido en Shopify: https://x.myshopify.com/admin/orders/1");
  });

  it("sin motivo ni productos no deja secciones vacías", () => {
    const { html } = renderEmail({ ...base, notice: undefined, items: undefined, totals: undefined, secondary: undefined });
    expect(html).not.toContain("Motivo informado");
    expect(html).not.toContain(">Productos<");
    expect(html).not.toContain("Ver pedido en Shopify");
  });

  it("clp formatea pesos chilenos", () => {
    expect(clp(2953)).toBe("$2.953");
    expect(clp(1234567.6)).toBe("$1.234.568");
  });
});
