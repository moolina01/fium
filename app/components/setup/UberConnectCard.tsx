import { Link } from "react-router";
import type { FetcherWithComponents } from "react-router";
import { colors as F, FONT, DISPLAY_FONT } from "../../lib/theme";

type UberConnectData = { error?: string; success?: boolean; intent?: string } | undefined;

/**
 * Formulario de conexión con Uber Direct — usado tanto a pantalla completa en el
 * onboarding como dentro del banner del dashboard. Misma lógica y copy en los dos
 * lugares: si el merchant sale a mitad de camino, el banner le muestra exactamente
 * lo mismo que dejó pendiente en el onboarding.
 */
export function UberConnectCard({
  fetcher,
  variant,
}: {
  fetcher: FetcherWithComponents<UberConnectData>;
  variant: "onboarding" | "banner";
}) {
  const busy = fetcher.state !== "idle";
  const error = fetcher.data?.error;
  const isOnboarding = variant === "onboarding";

  return (
    <div style={isOnboarding ? { width: "100%" } : bannerCard}>
      <div style={isOnboarding ? { marginBottom: "28px" } : bannerHeader}>
        <div style={isOnboarding ? onboardingHeading : bannerTitle}>
          Conecta tu cuenta de Uber Direct
        </div>
        <div style={isOnboarding ? onboardingSub : bannerDesc}>
          Sin esto, Fium no puede cotizar ni despachar tus envíos.
        </div>
      </div>

      <div style={isOnboarding ? undefined : bannerBody}>
        <div style={helpBox}>
          Estas credenciales vienen del dashboard de <strong>Uber Direct</strong> (direct.uber.com),
          en <strong>Developer → Credentials</strong>. Tu cuenta debe tener una tarjeta cargada: Uber
          cobra cada envío directamente a tu cuenta.
        </div>

        {error && <div style={errorBox}>⚠️ {error}</div>}

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="uber_credentials" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <Field label="Client ID">
              <input name="uberClientId" placeholder="kSoRrEVQ..." required style={inp} />
            </Field>
            <Field label="Customer ID">
              <input name="uberCustomerId" placeholder="UUID de la organización" required style={inp} />
            </Field>
            <Field label="Client Secret" fullWidth>
              <input
                name="uberClientSecret"
                type="password"
                autoComplete="off"
                placeholder="Pega tu Client Secret"
                required
                style={inp}
              />
            </Field>
          </div>
          <button type="submit" disabled={busy} style={submitBtn(busy)}>
            {busy ? "Probando conexión..." : "Probar y conectar →"}
          </button>
        </fetcher.Form>

        {isOnboarding && (
          <Link to="/app" style={skipLink}>
            Continuar después
          </Link>
        )}
      </div>
    </div>
  );
}

function Field({ label, children, fullWidth }: { label: string; children: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div style={{ gridColumn: fullWidth ? "1 / -1" : undefined }}>
      <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "5px", fontFamily: FONT }}>
        {label}
      </label>
      {children}
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

const bannerHeader: React.CSSProperties = {
  padding: "16px 20px",
  borderBottom: "1px solid #f3f4f6",
};

const bannerTitle: React.CSSProperties = { fontSize: "15px", fontWeight: "700", color: "#111827" };
const bannerDesc: React.CSSProperties = { fontSize: "13px", color: "#6b7280", marginTop: "2px" };
const bannerBody: React.CSSProperties = { padding: "16px 20px 20px" };

const onboardingHeading: React.CSSProperties = {
  fontSize: "26px", fontWeight: "700", color: F.ink, margin: "0 0 6px", fontFamily: DISPLAY_FONT,
};
const onboardingSub: React.CSSProperties = { fontSize: "14px", color: F.muted, margin: 0, lineHeight: "1.6" };

const helpBox: React.CSSProperties = {
  background: "#fafafe", border: "1px solid #E4E2F0", borderRadius: "8px",
  padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: "#6b7280", lineHeight: "1.6",
  fontFamily: FONT,
};

const errorBox: React.CSSProperties = {
  background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "8px",
  padding: "10px 14px", marginBottom: "16px", color: F.danger, fontSize: "13px", fontFamily: FONT,
};

const inp: React.CSSProperties = {
  width: "100%", padding: "12px 14px",
  border: "1.5px solid #e5e7eb", borderRadius: "8px",
  fontSize: "14px", color: "#111827", background: "white",
  boxSizing: "border-box", outline: "none", fontFamily: FONT,
};

function submitBtn(busy: boolean): React.CSSProperties {
  return {
    marginTop: "18px", width: "100%", padding: "14px",
    background: busy ? "#9b85ec" : F.brand, color: "#fff",
    border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: "600",
    cursor: busy ? "not-allowed" : "pointer", fontFamily: FONT,
    boxShadow: busy ? "none" : "0 4px 14px rgba(75,43,224,0.25)",
  };
}

const skipLink: React.CSSProperties = {
  display: "block", textAlign: "center", marginTop: "18px",
  fontSize: "13px", color: F.muted, textDecoration: "none", fontFamily: FONT,
};
