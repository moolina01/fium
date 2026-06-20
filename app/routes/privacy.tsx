import { FONT, DISPLAY_FONT, colors as F } from "../lib/theme";

// Cambia este correo por tu email oficial de contacto/soporte si quieres otro.
const CONTACT_EMAIL = "mhuryy22@gmail.com";
const LAST_UPDATED = "20 de junio de 2026";

/**
 * Página pública de Política de Privacidad.
 * URL: https://<tu-dominio>/privacy  → usar en Shopify (Partners) como Privacy policy URL.
 * No requiere autenticación: es para que Shopify y los merchants la puedan leer.
 */
export default function Privacy() {
  return (
    <main style={{ fontFamily: FONT, background: F.bg, color: F.text, minHeight: "100vh", margin: 0 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "56px 24px 80px", lineHeight: 1.7 }}>
        <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: 32, color: F.ink, margin: "0 0 6px" }}>
          Política de Privacidad de Fium
        </h1>
        <p style={{ color: F.muted, fontSize: 14, marginTop: 0 }}>Última actualización: {LAST_UPDATED}</p>

        <p>
          Fium (“la app”, “nosotros”) es una aplicación de Shopify que permite a las tiendas gestionar
          envíos express a través de Uber Direct. Esta política explica qué datos tratamos, cómo los
          usamos y con quién los compartimos.
        </p>

        <Section title="1. Información que recopilamos">
          <p>Cuando instalas y usas Fium en tu tienda Shopify, accedemos y tratamos:</p>
          <ul>
            <li>
              <strong>Datos de la tienda:</strong> nombre de contacto, teléfono, dirección de retiro,
              comuna, región, código postal y las credenciales de tu cuenta de Uber Direct (el
              <em> client secret</em> se almacena cifrado).
            </li>
            <li>
              <strong>Datos de las órdenes:</strong> número de pedido, nombre del cliente, dirección de
              entrega, comuna, teléfono del cliente y los productos del pedido — únicamente para coordinar
              el envío.
            </li>
          </ul>
          <p>No recopilamos ni almacenamos datos de pago (tarjetas) de los clientes finales.</p>
        </Section>

        <Section title="2. Cómo usamos la información">
          <ul>
            <li>Cotizar y crear envíos con Uber Direct.</li>
            <li>Mostrar el estado y el seguimiento de los envíos en tu panel.</li>
            <li>Marcar los pedidos como gestionados (fulfilled) en Shopify.</li>
          </ul>
        </Section>

        <Section title="3. Con quién compartimos la información">
          <ul>
            <li>
              <strong>Uber Direct:</strong> compartimos la dirección de retiro, la dirección de entrega y
              el teléfono de contacto para que el courier realice la entrega.
            </li>
            <li>
              <strong>Shopify:</strong> leemos las órdenes y actualizamos los fulfillments mediante su API.
            </li>
            <li>
              <strong>Proveedores de infraestructura:</strong> alojamiento (Railway) y base de datos
              (Supabase), usados exclusivamente para operar el servicio.
            </li>
          </ul>
          <p>No vendemos ni cedemos tus datos a terceros con fines publicitarios.</p>
        </Section>

        <Section title="4. Seguridad">
          <ul>
            <li>Las credenciales sensibles (como el secreto de Uber Direct) se almacenan cifradas (AES-256-GCM).</li>
            <li>Toda la comunicación con Shopify y Uber se realiza sobre HTTPS.</li>
          </ul>
        </Section>

        <Section title="5. Retención y eliminación de datos">
          <ul>
            <li>Conservamos los datos mientras la app esté instalada en tu tienda.</li>
            <li>Al <strong>desinstalar</strong> la app, eliminamos los datos asociados a tu tienda.</li>
            <li>
              Cumplimos los webhooks de privacidad de Shopify: solicitud de datos del cliente, eliminación
              de datos del cliente y eliminación de la tienda.
            </li>
          </ul>
        </Section>

        <Section title="6. Tus derechos">
          <p>
            Puedes solicitar acceso, corrección o eliminación de tus datos escribiéndonos al correo de
            contacto indicado abajo.
          </p>
        </Section>

        <Section title="7. Contacto">
          <p>
            Para cualquier consulta sobre privacidad o tratamiento de datos:{" "}
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
