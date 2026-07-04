import type { FetcherWithComponents } from "react-router";
import { Link } from "react-router";
import { colors as F, FONT, DISPLAY_FONT } from "../../lib/theme";

type ShopifyActivationData = { error?: string; success?: boolean; intent?: string } | undefined;

/**
 * Paso combinado "Activa Fium en tu checkout" — junta 2 confirmaciones (agregar
 * la tarifa a la zona de envío + exigir teléfono) bajo un solo botón, porque
 * ambas viven en la misma sección de Configuración de Shopify. Se usa a pantalla
 * completa en el onboarding y dentro del banner del dashboard con la misma
 * lógica/copy, para que abandonar el onboarding no cambie lo que el merchant ve.
 */
export function ShopifyActivationCard({
  fetcher,
  registerFetcher,
  variant,
  carrierRegistered,
  carrierActivatedAck,
  phoneRequiredAck,
  carrierLiveAt,
}: {
  fetcher: FetcherWithComponents<ShopifyActivationData>;
  registerFetcher: FetcherWithComponents<ShopifyActivationData>;
  variant: "onboarding" | "banner";
  carrierRegistered: boolean;
  carrierActivatedAck: boolean;
  phoneRequiredAck: boolean;
  carrierLiveAt: string | null;
}) {
  const busy = fetcher.state !== "idle";
  const registering = registerFetcher.state !== "idle";
  const isOnboarding = variant === "onboarding";
  const carrierDone = carrierActivatedAck || !!carrierLiveAt;

  return (
    <div style={isOnboarding ? { width: "100%" } : bannerCard}>
      <div style={isOnboarding ? { marginBottom: "28px" } : bannerHeader}>
        <div style={isOnboarding ? onboardingHeading : bannerTitle}>Activa Fium en tu checkout</div>
        <div style={isOnboarding ? onboardingSub : bannerDesc}>
          2 pasos en Configuración de Shopify — luego confirma aquí.
        </div>
      </div>

      <div style={isOnboarding ? undefined : bannerBody}>
        {/* Sub-estado: 2 líneas, para que se vea qué falta específicamente aunque
            la confirmación final sea un solo botón. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
          <SubStatus done={carrierDone} label="Fium agregado a tu zona de envío" />
          <SubStatus done={phoneRequiredAck} label="Teléfono obligatorio en el checkout" />
        </div>

        {!carrierRegistered ? (
          <>
            <div style={warnBox}>
              ⚠️ Fium <strong>no está registrado</strong> como servicio de envío. Regístralo primero para
              poder agregarlo a tu zona de envío.
            </div>
            {registerFetcher.data?.error && <div style={errorBox}>⚠️ {registerFetcher.data.error}</div>}
            <registerFetcher.Form method="post">
              <input type="hidden" name="intent" value="register_carrier" />
              <button type="submit" disabled={registering} style={submitBtn(registering)}>
                {registering ? "Registrando..." : "Registrar Fium en el checkout"}
              </button>
            </registerFetcher.Form>
          </>
        ) : (
          <>
            <ol style={stepsList}>
              <li>
                En Shopify ve a <strong>Configuración → Envío y entrega</strong>, abre tu zona de envío
                y agrega la tarifa <strong>Fium</strong> (aparece en la lista de transportistas).
              </li>
              <li>
                Ve a <strong>Configuración → Pagos / Checkout → Información de contacto</strong> y marca
                el teléfono como <strong>obligatorio</strong>.
              </li>
            </ol>

            {fetcher.data?.error && <div style={errorBox}>⚠️ {fetcher.data.error}</div>}

            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="ack_shopify_activation" />
              <button type="submit" disabled={busy} style={submitBtn(busy)}>
                {busy ? "Guardando..." : "Ya hice esto en Shopify"}
              </button>
            </fetcher.Form>

            <registerFetcher.Form method="post" style={{ marginTop: "10px" }}>
              <input type="hidden" name="intent" value="register_carrier" />
              <button type="submit" disabled={registering} style={ghostLink}>
                {registering ? "Registrando..." : "¿Fium no aparece en la lista? Vuelve a registrarlo"}
              </button>
            </registerFetcher.Form>
          </>
        )}

        {isOnboarding && (
          <Link to="/app" style={skipLink}>
            Continuar después
          </Link>
        )}
      </div>
    </div>
  );
}

function SubStatus({ done, label }: { done: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <div style={{
        width: "18px", height: "18px", borderRadius: "50%", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "11px", fontWeight: "700",
        background: done ? F.success : "#f3f4f6",
        color: done ? "white" : "#9ca3af",
      }}>
        {done ? "✓" : ""}
      </div>
      <span style={{ fontSize: "13px", fontWeight: "500", color: done ? F.success : "#374151", fontFamily: FONT }}>
        {label}
      </span>
    </div>
  );
}

const bannerCard: React.CSSProperties = {
  background: "white",
  border: `2px solid ${F.brand}`,
  borderRadius: "12px",
  overflow: "hidden",
  fontFamily: FONT,
};

const bannerHeader: React.CSSProperties = { padding: "16px 20px", borderBottom: "1px solid #f3f4f6" };
const bannerTitle: React.CSSProperties = { fontSize: "15px", fontWeight: "700", color: "#111827" };
const bannerDesc: React.CSSProperties = { fontSize: "13px", color: "#6b7280", marginTop: "2px" };
const bannerBody: React.CSSProperties = { padding: "16px 20px 20px" };

const onboardingHeading: React.CSSProperties = {
  fontSize: "26px", fontWeight: "700", color: F.ink, margin: "0 0 6px", fontFamily: DISPLAY_FONT,
};
const onboardingSub: React.CSSProperties = { fontSize: "14px", color: F.muted, margin: 0, lineHeight: "1.6" };

const stepsList: React.CSSProperties = {
  margin: "0 0 16px", paddingLeft: "18px", fontSize: "13px", color: "#374151", lineHeight: "1.7", fontFamily: FONT,
};

const warnBox: React.CSSProperties = {
  background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px",
  padding: "10px 14px", marginBottom: "16px", fontSize: "13px", color: "#b91c1c", lineHeight: "1.6", fontFamily: FONT,
};

const errorBox: React.CSSProperties = {
  background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "8px",
  padding: "10px 14px", marginBottom: "16px", color: F.danger, fontSize: "13px", fontFamily: FONT,
};

function submitBtn(busy: boolean): React.CSSProperties {
  return {
    width: "100%", padding: "14px",
    background: busy ? "#9b85ec" : F.brand, color: "#fff",
    border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: "600",
    cursor: busy ? "not-allowed" : "pointer", fontFamily: FONT,
    boxShadow: busy ? "none" : "0 4px 14px rgba(75,43,224,0.25)",
  };
}

const ghostLink: React.CSSProperties = {
  display: "block", width: "100%", padding: "0", background: "none", border: "none",
  color: "#9ca3af", textDecoration: "underline", fontSize: "12px", textAlign: "center",
  cursor: "pointer", fontFamily: FONT,
};

const skipLink: React.CSSProperties = {
  display: "block", textAlign: "center", marginTop: "18px",
  fontSize: "13px", color: F.muted, textDecoration: "none", fontFamily: FONT,
};
