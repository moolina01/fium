import { FONT, DISPLAY_FONT, colors as F } from "../lib/theme";

// Cambia este correo por tu email oficial de contacto/soporte si quieres otro.
const CONTACT_EMAIL = "mhuryy22@gmail.com";

/**
 * Página pública del modelo de cobro de Fium.
 * URL: https://<tu-dominio>/billing
 * No requiere autenticación: es para que Shopify (revisores) y los merchants la
 * puedan leer. Explica que Fium es gratis y que los envíos se pagan fuera de la
 * Shopify Billing API (exención otorgada por Shopify).
 */
export default function Billing() {
  return (
    <main style={{ fontFamily: FONT, background: F.bg, color: F.text, minHeight: "100vh", margin: 0 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "56px 24px 80px", lineHeight: 1.7 }}>
        <span style={{
          display: "inline-block", background: F.accent, color: F.ink,
          fontSize: 12, fontWeight: 800, letterSpacing: "0.5px",
          padding: "4px 12px", borderRadius: 99, marginBottom: 16,
        }}>
          APP GRATUITA
        </span>

        <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: 32, color: F.ink, margin: "0 0 18px" }}>
          Modelo de cobro de Fium
        </h1>

        <p style={{ fontSize: 18, color: F.ink, fontWeight: 600, margin: "0 0 8px" }}>
          Fium es una aplicación gratuita.
        </p>
        <p style={{ margin: "0 0 8px" }}>
          No cobramos ninguna suscripción, comisión ni cargo por el uso de la app.
        </p>

        <Section title="¿Cómo funcionan los costos de envío?">
          <p>
            Fium integra Uber Direct para ofrecer despachos el mismo día. Los costos de cada
            envío se pagan de la siguiente forma:
          </p>
          <ul>
            <li>Cada comercio conecta su propia cuenta de Uber Direct usando sus propias credenciales.</li>
            <li>Las tarifas de envío se calculan en tiempo real y se muestran al cliente en el checkout.</li>
            <li>El costo de cada despacho se paga directamente entre el comercio y Uber Direct.</li>
            <li>Fium no procesa, retiene ni intermedia ningún pago.</li>
          </ul>
          <p>
            Estos cobros ocurren fuera de la Shopify Billing API, por lo que contamos con una
            exención de Billing API otorgada por Shopify.
          </p>
        </Section>

        <Section title="Contacto">
          <p>
            Para más información, contáctanos en:{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: F.brand, fontWeight: 600 }}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontFamily: DISPLAY_FONT, fontSize: 20, color: F.ink, margin: "0 0 8px" }}>{title}</h2>
      {children}
    </section>
  );
}
