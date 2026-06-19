import { Fragment, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useNavigation } from "react-router";
import { ClipboardList, MousePointerClick, PackageCheck, ShoppingBag } from "lucide-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { REGIONES, REGIONES_COMUNAS } from "../data/chile";
import { colors as F, FONT, DISPLAY_FONT } from "../lib/theme";

// ─── CSS keyframes ────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
@keyframes fuFadeUp {
  from { opacity: 0; transform: translateY(22px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fuSlideRight {
  from { opacity: 0; transform: translateX(32px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes fuSlideLeft {
  from { opacity: 0; transform: translateX(-32px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes fuCheckCircle {
  from { stroke-dashoffset: 200; }
  to   { stroke-dashoffset: 0; }
}
@keyframes fuCheckMark {
  from { stroke-dashoffset: 50; }
  to   { stroke-dashoffset: 0; }
}
@keyframes fuBubbleRise {
  0%   { transform: translateY(0) scale(0.6); opacity: 0; }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { transform: translateY(-118vh) scale(1.15); opacity: 0; }
}
@keyframes fuBubbleSway {
  0%   { transform: translateX(0); }
  25%  { transform: translateX(28px); }
  50%  { transform: translateX(-18px); }
  75%  { transform: translateX(22px); }
  100% { transform: translateX(0); }
}
@keyframes fuPulse {
  0%   { box-shadow: 0 0 0 0 rgba(201,240,60,0.6); }
  70%  { box-shadow: 0 0 0 7px rgba(201,240,60,0); }
  100% { box-shadow: 0 0 0 0 rgba(201,240,60,0); }
}
@keyframes fuStreak {
  0%   { transform: translateX(-120%); opacity: 0; }
  10%  { opacity: 1; }
  90%  { opacity: 1; }
  100% { transform: translateX(120vw); opacity: 0; }
}
`;

function fu(delay = 0, duration = 500): React.CSSProperties {
  return { animation: `fuFadeUp ${duration}ms ${delay}ms cubic-bezier(0.22,1,0.36,1) both` };
}

// ─── Server ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const config = await db.storeConfig.findUnique({ where: { shop: session.shop } });
  if (config) throw redirect("/app");
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = {
    shop: session.shop,
    contactName: formData.get("contactName") as string,
    phone: formData.get("phone") as string,
    address: formData.get("address") as string,
    region: formData.get("region") as string,
    comuna: formData.get("comuna") as string,
    zipCode: formData.get("zipCode") as string,
  };
  const missing = Object.entries(data).filter(([k, v]) => k !== "shop" && !v);
  if (missing.length > 0) return { error: "Completa todos los campos para continuar." };
  await db.storeConfig.create({ data });
  return { success: true };
};

// ─── Main component ───────────────────────────────────────────────────────────
type Step = 0 | 1 | 2 | 3;

export default function Onboarding() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [step, setStep] = useState<Step>(0);
  const [animKey, setAnimKey] = useState(0);

  useEffect(() => {
    if (actionData && "success" in actionData && actionData.success) {
      setStep(3);
      setAnimKey((k) => k + 1);
    }
  }, [actionData]);

  function goTo(s: Step) {
    setStep(s);
    setAnimKey((k) => k + 1);
  }

  const isDark = step === 0;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      {/* Top progress bar */}
      {step > 0 && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 3, zIndex: 100, background: F.border }}>
          <div style={{
            height: "100%",
            width: step === 3 ? "100%" : `${(step / 3) * 100}%`,
            background: step === 3 ? F.success : F.brand,
            borderRadius: "0 2px 2px 0",
            transition: "width 0.55s cubic-bezier(0.22,1,0.36,1), background 0.3s ease",
          }} />
        </div>
      )}

      <div style={{
        minHeight: "100vh",
        background: isDark
          ? "linear-gradient(145deg, #0A0720 0%, #1A0E5C 55%, #3B1DC0 100%)"
          : F.bg,
        fontFamily: FONT,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: isDark ? "0 20px" : "60px 20px 80px",
        transition: "background 0.5s ease",
        position: "relative",
        overflow: "hidden",
      }}>
        {isDark && <Bubbles />}
        {isDark && <Streaks />}
        <div
          key={animKey}
          style={{
            width: "100%",
            maxWidth: step === 0 ? "520px" : "480px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            position: "relative",
            zIndex: 1,
            ...(isDark ? { minHeight: "100vh", justifyContent: "center" } : {}),
          }}
        >
          {step === 0 && <WelcomeStep onNext={() => goTo(1)} />}
          {step === 1 && <HowItWorksStep onNext={() => goTo(2)} />}
          {step === 2 && (
            <ConversationalForm
              saving={saving}
              error={actionData && "error" in actionData ? actionData.error : undefined}
              onBack={() => goTo(1)}
            />
          )}
          {step === 3 && <DoneStep />}
        </div>
      </div>
    </>
  );
}

// ─── Step 0: Welcome ──────────────────────────────────────────────────────────
function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div style={{ textAlign: "center", padding: "20px 0", width: "100%" }}>
      {/* Logo: icono + wordmark en blanco */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginBottom: "48px", ...fu(0) }}>
        <img src="/fium-icono.svg" alt="" height={40} width={40} />
        <span style={{ fontFamily: DISPLAY_FONT, fontWeight: 700, fontSize: "26px", color: "#EDEBFA", letterSpacing: "-0.5px" }}>
          fium
        </span>
      </div>

      <div style={{
        display: "inline-flex", alignItems: "center", gap: "7px",
        background: "rgba(201,240,60,0.12)", border: "1px solid rgba(201,240,60,0.3)",
        color: "#C9F03C", fontSize: "12px", fontWeight: "600",
        padding: "5px 14px", borderRadius: "99px", marginBottom: "24px",
        letterSpacing: "0.4px", ...fu(80),
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: "50%", background: "#C9F03C", display: "inline-block",
          animation: "fuPulse 1.8s ease-out infinite",
        }} />
        Envíos express · Uber Direct
      </div>

      <h1 style={{
        fontSize: "clamp(28px, 6vw, 44px)", fontWeight: "700",
        color: "#EDEBFA", margin: "0 0 18px", lineHeight: "1.15",
        fontFamily: DISPLAY_FONT, ...fu(160),
      }}>
        Despacha pedidos<br />en menos de 60 min
      </h1>

      <p style={{
        fontSize: "16px", color: "rgba(237,235,250,0.65)", lineHeight: "1.75",
        margin: "0 auto 52px", maxWidth: "400px", ...fu(240),
      }}>
        Conecta tu tienda Shopify con Uber Direct y gestiona envío express con un clic.
      </p>

      <button
        onClick={onNext}
        style={{
          padding: "14px 40px", background: "#C9F03C", color: "#241266",
          border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: "700",
          cursor: "pointer", fontFamily: FONT,
          boxShadow: "0 8px 28px rgba(201,240,60,0.28)",
          transition: "transform 0.15s ease, box-shadow 0.15s ease",
          ...fu(320),
        }}
        onMouseEnter={(e) => {
          (e.currentTarget).style.transform = "translateY(-2px)";
          (e.currentTarget).style.boxShadow = "0 12px 32px rgba(201,240,60,0.38)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget).style.transform = "";
          (e.currentTarget).style.boxShadow = "0 8px 28px rgba(201,240,60,0.28)";
        }}
      >
        Comenzar →
      </button>

      <div style={{ display: "flex", gap: "40px", justifyContent: "center", marginTop: "64px", ...fu(400) }}>
        {[
          { end: 60, suffix: " min", label: "tiempo máximo" },
          { end: 1,  suffix: " clic", label: "para despachar" },
          { end: 24, suffix: "/7",   label: "disponible" },
        ].map((stat, i) => (
          <div key={stat.label} style={{ textAlign: "center" }}>
            <div style={{ fontSize: "20px", fontWeight: "700", color: "#EDEBFA", fontFamily: DISPLAY_FONT, letterSpacing: "-0.5px" }}>
              <CountUp end={stat.end} delay={520 + i * 140} />{stat.suffix}
            </div>
            <div style={{ fontSize: "12px", color: "rgba(237,235,250,0.45)", marginTop: "3px" }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Crédito de la agencia */}
      <div style={{
        display: "inline-flex", alignItems: "center", gap: "7px",
        marginTop: "56px", ...fu(480),
      }}>
        <span style={{ fontSize: "11px", color: "rgba(237,235,250,0.4)", letterSpacing: "0.4px" }}>
          Desarrollado por
        </span>
        <span style={{
          fontSize: "12px", fontWeight: "700", color: "rgba(237,235,250,0.7)",
          fontFamily: DISPLAY_FONT, letterSpacing: "0.2px",
        }}>
          Rock Agency
        </span>
      </div>
    </div>
  );
}

// ─── Step 1: How it works ─────────────────────────────────────────────────────
function HowItWorksStep({ onNext }: { onNext: () => void }) {
  const steps = [
    { Icon: ShoppingBag,       title: "El cliente elige fium",     desc: "En el checkout aparece la opción de envío express con Uber Direct." },
    { Icon: ClipboardList,     title: "Ves la orden en tu panel",   desc: "El pedido llega a fium con todos los detalles listos para despachar." },
    { Icon: MousePointerClick, title: "Despachas con un clic",      desc: "Confirmas el envío y Uber Direct asigna un courier automáticamente." },
    { Icon: PackageCheck,      title: "El courier entrega",         desc: "Tu cliente recibe su pedido en menos de 60 min, con seguimiento." },
  ];

  return (
    <div style={{ width: "100%" }}>
      <div style={{ textAlign: "center", marginBottom: "32px", ...fu(0) }}>
        <h2 style={{ fontSize: "26px", fontWeight: "700", color: F.ink, margin: "0 0 8px", fontFamily: DISPLAY_FONT }}>
          Así funciona fium
        </h2>
        <p style={{ fontSize: "14px", color: F.muted, margin: 0 }}>De la orden a la entrega, sin salir del admin</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "28px" }}>
        {steps.map((s, i) => (
          <div key={s.title} style={{
            display: "flex", alignItems: "flex-start", gap: "16px",
            background: F.surface, borderRadius: "12px",
            border: `1px solid ${F.border}`, padding: "18px 20px",
            boxShadow: "0 1px 4px rgba(36,18,102,0.04)",
            ...fu(i * 70),
          }}>
            <div style={{
              width: 42, height: 42, borderRadius: "10px",
              background: F.brandTint, display: "flex",
              alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <s.Icon size={20} color={F.brand} strokeWidth={1.75} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "13px", fontWeight: "700", color: F.ink, marginBottom: "3px" }}>{s.title}</div>
              <div style={{ fontSize: "13px", color: F.muted, lineHeight: "1.5" }}>{s.desc}</div>
            </div>
            <div style={{ fontSize: "11px", fontWeight: "700", color: F.border, flexShrink: 0, paddingTop: "2px" }}>
              0{i + 1}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onNext}
        style={{
          width: "100%", padding: "14px", background: F.brand, color: "#fff",
          border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: "600",
          cursor: "pointer", fontFamily: FONT,
          boxShadow: "0 4px 14px rgba(75,43,224,0.25)",
          transition: "background 0.15s ease",
          ...fu(300),
        }}
        onMouseEnter={(e) => { (e.currentTarget).style.background = F.brandHover; }}
        onMouseLeave={(e) => { (e.currentTarget).style.background = F.brand; }}
      >
        Configurar mi tienda →
      </button>
    </div>
  );
}

// ─── Step 2: Conversational form ──────────────────────────────────────────────
type FormValues = {
  contactName: string;
  phone: string;
  address: string;
  region: string;
  comuna: string;
  zipCode: string;
};

const QUESTIONS = [
  {
    key: "contactName" as keyof FormValues,
    question: "¿Cómo te llamamos?",
    hint: "Nombre de contacto para el courier",
    placeholder: "ej. Juan Pérez",
    type: "text" as const,
  },
  {
    key: "phone" as keyof FormValues,
    question: "¿Tu número de teléfono?",
    hint: "El courier te contactará aquí si hay algún problema",
    placeholder: "+56 9 1234 5678",
    type: "tel" as const,
  },
  {
    key: "address" as keyof FormValues,
    question: "¿Desde qué dirección retiramos?",
    hint: "El courier viene aquí a buscar tus pedidos",
    placeholder: "Av. Providencia 1234, Local 5",
    type: "text" as const,
  },
  {
    key: "region" as keyof FormValues,
    question: "¿En qué región estás?",
    hint: "",
    type: "region-select" as const,
  },
  {
    key: "comuna" as keyof FormValues,
    question: "¿Y en qué comuna?",
    hint: "",
    type: "comuna-select" as const,
  },
  {
    key: "zipCode" as keyof FormValues,
    question: "¿Código postal?",
    hint: "Lo usamos para calcular la cobertura exacta",
    placeholder: "7500000",
    type: "text" as const,
  },
] as const;

function ConversationalForm({
  saving,
  error,
  onBack,
}: {
  saving: boolean;
  error?: string;
  onBack: () => void;
}) {
  const total = QUESTIONS.length;
  const [subStep, setSubStep] = useState(0);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [animKey, setAnimKey] = useState(0);
  const [values, setValues] = useState<FormValues>({
    contactName: "", phone: "", address: "", region: "", comuna: "", zipCode: "",
  });
  const [currentInput, setCurrentInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isReview = subStep === total;
  const comunas = values.region ? (REGIONES_COMUNAS[values.region] ?? []) : [];

  // Auto-focus text inputs when question changes
  useEffect(() => {
    if (!isReview) {
      const q = QUESTIONS[subStep];
      setCurrentInput(values[q.key] ?? "");
      if (q.type === "text" || q.type === "tel") {
        setTimeout(() => inputRef.current?.focus(), 320);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subStep]);

  function advance(override?: string) {
    const val = override ?? currentInput;
    if (!val.trim()) return;
    const q = QUESTIONS[subStep];
    const updated = { ...values, [q.key]: val };
    if (q.key === "region") updated.comuna = "";
    setValues(updated);
    setDir("fwd");
    setAnimKey((k) => k + 1);
    setSubStep((s) => s + 1);
    setCurrentInput("");
  }

  function retreat() {
    if (subStep === 0) { onBack(); return; }
    setDir("back");
    setAnimKey((k) => k + 1);
    setSubStep((s) => s - 1);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && currentInput.trim()) { e.preventDefault(); advance(); }
  }

  const slideStyle: React.CSSProperties = {
    animation: `${dir === "fwd" ? "fuSlideRight" : "fuSlideLeft"} 0.38s cubic-bezier(0.22,1,0.36,1) both`,
  };

  if (isReview) {
    return (
      <ReviewScreen
        values={values}
        saving={saving}
        error={error}
        onEdit={(i) => {
          setDir("back");
          setAnimKey((k) => k + 1);
          setSubStep(i);
        }}
      />
    );
  }

  const q = QUESTIONS[subStep];
  const isSelect = q.type === "region-select" || q.type === "comuna-select";
  const canAdvance = currentInput.trim().length > 0;

  return (
    <div style={{ width: "100%" }}>
      {/* Back */}
      <button
        onClick={retreat}
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: F.muted, fontSize: "13px", marginBottom: "36px",
          display: "flex", alignItems: "center", gap: "4px",
          padding: 0, fontFamily: FONT,
        }}
      >
        ← {subStep === 0 ? "Volver" : "Anterior"}
      </button>

      {/* Mini progress */}
      <div style={{ marginBottom: "48px" }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px",
        }}>
          <span style={{ fontSize: "11px", color: F.muted, fontWeight: "600", letterSpacing: "0.5px" }}>
            PUNTO DE RETIRO
          </span>
          <span style={{ fontSize: "11px", color: F.brand, fontWeight: "700" }}>
            {subStep + 1} / {total}
          </span>
        </div>
        <div style={{ height: 3, background: F.border, borderRadius: 99 }}>
          <div style={{
            height: "100%",
            width: `${((subStep + 1) / total) * 100}%`,
            background: F.brand, borderRadius: 99,
            transition: "width 0.4s cubic-bezier(0.22,1,0.36,1)",
          }} />
        </div>
      </div>

      {/* Question + input */}
      <div key={animKey} style={slideStyle}>
        <div style={{ marginBottom: "36px" }}>
          <h2 style={{
            fontSize: "30px", fontWeight: "700", color: F.ink,
            margin: "0 0 8px", fontFamily: DISPLAY_FONT, lineHeight: "1.2",
          }}>
            {q.question}
          </h2>
          {q.hint && (
            <p style={{ fontSize: "13px", color: F.muted, margin: 0, lineHeight: "1.5" }}>
              {q.hint}
            </p>
          )}
        </div>

        {/* Text / tel input */}
        {(q.type === "text" || q.type === "tel") && (
          <input
            ref={inputRef}
            type={q.type}
            value={currentInput}
            onChange={(e) => setCurrentInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={"placeholder" in q ? q.placeholder : ""}
            style={{
              display: "block", width: "100%", padding: "16px 18px",
              border: `2px solid ${canAdvance ? F.brand : F.border}`,
              borderRadius: "12px", fontSize: "18px", color: F.text,
              background: F.surface, boxSizing: "border-box",
              outline: "none", fontFamily: FONT,
              transition: "border-color 0.2s ease",
              marginBottom: "20px",
            }}
            onFocus={(e) => { e.target.style.borderColor = F.brand; }}
            onBlur={(e) => { e.target.style.borderColor = canAdvance ? F.brand : F.border; }}
          />
        )}

        {/* Region select */}
        {q.type === "region-select" && (
          <select
            value={currentInput}
            onChange={(e) => {
              setCurrentInput(e.target.value);
            }}
            style={selectCss(!!currentInput)}
          >
            <option value="">Selecciona una región...</option>
            {REGIONES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        )}

        {/* Comuna select */}
        {q.type === "comuna-select" && (
          <select
            value={currentInput}
            onChange={(e) => setCurrentInput(e.target.value)}
            disabled={!values.region}
            style={selectCss(!!currentInput)}
          >
            <option value="">Selecciona una comuna...</option>
            {comunas.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}

        <button
          onClick={() => advance()}
          disabled={!canAdvance}
          style={{
            marginTop: isSelect ? "16px" : "0",
            width: "100%", padding: "14px",
            background: canAdvance ? F.brand : F.border,
            color: canAdvance ? "#fff" : F.muted,
            border: "none", borderRadius: "10px",
            fontSize: "15px", fontWeight: "600",
            cursor: canAdvance ? "pointer" : "not-allowed",
            fontFamily: FONT,
            boxShadow: canAdvance ? "0 4px 14px rgba(75,43,224,0.22)" : "none",
            transition: "background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease",
          }}
        >
          {subStep === total - 1 ? "Ver resumen →" : "Continuar →"}
        </button>

        {!isSelect && (
          <p style={{ textAlign: "center", fontSize: "12px", color: F.muted, marginTop: "12px" }}>
            o presiona Enter
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Review screen ─────────────────────────────────────────────────────────────
function ReviewScreen({
  values,
  saving,
  error,
  onEdit,
}: {
  values: FormValues;
  saving: boolean;
  error?: string;
  onEdit: (i: number) => void;
}) {
  const rows = [
    { label: "Nombre", value: values.contactName, step: 0 },
    { label: "Teléfono", value: values.phone, step: 1 },
    { label: "Dirección", value: values.address, step: 2 },
    { label: "Región", value: values.region, step: 3 },
    { label: "Comuna", value: values.comuna, step: 4 },
    { label: "Cód. postal", value: values.zipCode, step: 5 },
  ];

  return (
    <div style={{ width: "100%", ...fu(0) }}>
      <div style={{ marginBottom: "28px" }}>
        <h2 style={{ fontSize: "26px", fontWeight: "700", color: F.ink, margin: "0 0 6px", fontFamily: DISPLAY_FONT }}>
          ¿Todo correcto?
        </h2>
        <p style={{ fontSize: "14px", color: F.muted, margin: 0 }}>
          Así queda guardado tu punto de retiro.
        </p>
      </div>

      {error && (
        <div style={{
          background: "#FEF2F2", border: "1px solid #FECACA",
          borderRadius: "8px", padding: "10px 14px",
          color: F.danger, fontSize: "13px", marginBottom: "16px",
        }}>
          ⚠️ {error}
        </div>
      )}

      <div style={{
        background: F.surface, borderRadius: "12px",
        border: `1px solid ${F.border}`, overflow: "hidden", marginBottom: "20px",
        boxShadow: "0 1px 4px rgba(36,18,102,0.05)",
      }}>
        {rows.map((row, i) => (
          <div key={row.label} style={{
            display: "flex", alignItems: "center",
            padding: "13px 18px",
            borderBottom: i < rows.length - 1 ? `1px solid ${F.border}` : "none",
          }}>
            <span style={{ fontSize: "12px", color: F.muted, width: "90px", flexShrink: 0 }}>
              {row.label}
            </span>
            <span style={{ fontSize: "14px", color: F.text, fontWeight: "500", flex: 1 }}>
              {row.value}
            </span>
            <button
              onClick={() => onEdit(row.step)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: F.brand, fontSize: "12px", fontWeight: "600",
                padding: "2px 8px", fontFamily: FONT, borderRadius: "4px",
              }}
            >
              Editar
            </button>
          </div>
        ))}
      </div>

      <Form method="post">
        <input type="hidden" name="contactName" value={values.contactName} />
        <input type="hidden" name="phone" value={values.phone} />
        <input type="hidden" name="address" value={values.address} />
        <input type="hidden" name="region" value={values.region} />
        <input type="hidden" name="comuna" value={values.comuna} />
        <input type="hidden" name="zipCode" value={values.zipCode} />
        <button
          type="submit"
          disabled={saving}
          style={{
            width: "100%", padding: "14px",
            background: saving ? "#9b85ec" : F.brand,
            color: "#fff", border: "none", borderRadius: "10px",
            fontSize: "15px", fontWeight: "600",
            cursor: saving ? "not-allowed" : "pointer",
            fontFamily: FONT,
            boxShadow: saving ? "none" : "0 4px 14px rgba(75,43,224,0.25)",
          }}
        >
          {saving ? "Guardando..." : "Guardar y continuar →"}
        </button>
      </Form>
    </div>
  );
}

// ─── Step 3: Done ─────────────────────────────────────────────────────────────
function DoneStep() {
  // TEMP(promt02): clientes de prueba sin cobro → ocultamos "Elige tu plan".
  // El siguiente paso pasa a ser activar Fium en el checkout (desde Configuración).
  // Revertir cuando se cobre: volver a agregar { done: false, label: "Elige tu plan" }.
  const items = [
    { done: true,  label: "Dirección de retiro guardada" },
    { done: false, label: "Conecta tu cuenta de Uber Direct" },
    { done: false, label: "Activa Fium en el checkout de Shopify" },
    { done: false, label: "Exige teléfono en el checkout" },
  ];

  return (
    <div style={{ width: "100%", textAlign: "center" }}>
      <div style={{ marginBottom: "28px", ...fu(0, 400) }}>
        <svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle
            cx="36" cy="36" r="32"
            stroke={F.success} strokeWidth="2.5"
            fill={F.successTint}
            strokeDasharray="200"
            style={{ animation: "fuCheckCircle 0.6s 0.1s cubic-bezier(0.22,1,0.36,1) both" }}
          />
          <polyline
            points="22,36 31,46 50,26"
            stroke={F.success} strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round"
            fill="none"
            strokeDasharray="50"
            style={{ animation: "fuCheckMark 0.4s 0.7s cubic-bezier(0.22,1,0.36,1) both" }}
          />
        </svg>
      </div>

      <h2 style={{ fontSize: "24px", fontWeight: "700", color: F.ink, margin: "0 0 8px", fontFamily: DISPLAY_FONT, ...fu(100) }}>
        ¡Tu cuenta está lista!
      </h2>
      <p style={{ fontSize: "14px", color: F.muted, margin: "0 0 32px", ...fu(160) }}>
        Sigue estos pasos para que fium funcione en tu tienda.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "28px", textAlign: "left", ...fu(220) }}>
        {items.map((item) => (
          <div key={item.label} style={{
            display: "flex", alignItems: "center", gap: "14px",
            background: item.done ? F.successTint : F.surface,
            border: `1px solid ${item.done ? "#A7E6C8" : F.border}`,
            borderRadius: "10px", padding: "14px 16px",
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: item.done ? F.success : F.brandTint,
              color: item.done ? "#fff" : F.brand,
              fontSize: "13px", fontWeight: "700",
            }}>
              {item.done ? "✓" : "→"}
            </div>
            <span style={{ fontSize: "14px", fontWeight: "500", color: item.done ? F.success : F.text }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>

      {/* TEMP(promt02): antes iba a "/app/plans" ("Ir a mi plan").
          Ahora lleva directo a Configuración para activar Fium en el checkout.
          Revertir cuando se cobre: volver a to="/app/plans" y "Ir a mi plan →". */}
      <Link
        to="/app/settings"
        style={{
          display: "block", width: "100%", padding: "14px",
          background: F.brand, color: "#fff", borderRadius: "10px",
          fontSize: "15px", fontWeight: "600", textDecoration: "none",
          textAlign: "center", fontFamily: FONT,
          boxShadow: "0 4px 14px rgba(75,43,224,0.25)",
          ...fu(300),
        }}
      >
        Activar Fium en mi checkout →
      </Link>
    </div>
  );
}

// ─── CountUp (contador animado de las estadísticas) ─────────────────────────────
// Empieza en 0 (igual en server y client → sin mismatch de hidratación) y sube.
function CountUp({ end, duration = 1100, delay = 0 }: { end: number; duration?: number; delay?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min((t - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setN(Math.round(eased * end));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [end, duration, delay]);
  return <>{n}</>;
}

// ─── Bubbles (fondo animado del welcome) ────────────────────────────────────────
// Posiciones fijas (deterministas) para no romper la hidratación en SSR.
const BUBBLES = [
  { size: 200, left: "6%",  delay: 0,  dur: 24, sway: 9,  color: "rgba(201,240,60,0.10)" },
  { size: 120, left: "20%", delay: 7,  dur: 28, sway: 7,  color: "rgba(124,77,255,0.16)" },
  { size: 80,  left: "40%", delay: 3,  dur: 20, sway: 6,  color: "rgba(201,240,60,0.08)" },
  { size: 240, left: "58%", delay: 10, dur: 32, sway: 11, color: "rgba(124,77,255,0.12)" },
  { size: 64,  left: "74%", delay: 2,  dur: 18, sway: 5,  color: "rgba(201,240,60,0.14)" },
  { size: 150, left: "86%", delay: 8,  dur: 26, sway: 8,  color: "rgba(124,77,255,0.13)" },
  { size: 100, left: "32%", delay: 13, dur: 30, sway: 10, color: "rgba(201,240,60,0.07)" },
  { size: 56,  left: "52%", delay: 5,  dur: 16, sway: 4,  color: "rgba(124,77,255,0.18)" },
];

function Bubbles() {
  return (
    <div
      aria-hidden
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}
    >
      {BUBBLES.map((b, i) => (
        // Capa externa: sube. Capa interna: se balancea de lado (movimiento orgánico).
        <span
          key={i}
          style={{
            position: "absolute",
            bottom: `-${b.size}px`,
            left: b.left,
            width: b.size,
            height: b.size,
            animation: `fuBubbleRise ${b.dur}s ${b.delay}s ease-in-out infinite`,
          }}
        >
          <span
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              borderRadius: "50%",
              background: b.color,
              filter: "blur(8px)",
              animation: `fuBubbleSway ${b.sway}s ${b.delay}s ease-in-out infinite`,
            }}
          />
        </span>
      ))}
    </div>
  );
}

// ─── Streaks (líneas de velocidad que cruzan el fondo) ──────────────────────────
const STREAKS = [
  { top: "14%", width: 160, dur: 2.4, delay: 0,   color: "rgba(201,240,60,0.55)" },
  { top: "27%", width: 90,  dur: 1.7, delay: 1.3, color: "rgba(237,235,250,0.30)" },
  { top: "41%", width: 130, dur: 2.1, delay: 0.6, color: "rgba(201,240,60,0.35)" },
  { top: "55%", width: 70,  dur: 1.5, delay: 2.0, color: "rgba(237,235,250,0.35)" },
  { top: "68%", width: 180, dur: 2.7, delay: 0.9, color: "rgba(201,240,60,0.30)" },
  { top: "82%", width: 100, dur: 1.9, delay: 1.8, color: "rgba(237,235,250,0.25)" },
];

function Streaks() {
  return (
    <div
      aria-hidden
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}
    >
      {STREAKS.map((s, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            top: s.top,
            left: 0,
            width: s.width,
            height: 2,
            borderRadius: 2,
            background: `linear-gradient(90deg, transparent, ${s.color}, transparent)`,
            animation: `fuStreak ${s.dur}s ${s.delay}s linear infinite`,
          }}
        />
      ))}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function selectCss(filled: boolean): React.CSSProperties {
  return {
    display: "block", width: "100%", padding: "16px 44px 16px 18px",
    border: `2px solid ${filled ? F.brand : F.border}`,
    borderRadius: "12px", fontSize: "16px",
    color: filled ? F.text : F.muted,
    background: `${F.surface} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236E6B85' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 18px center`,
    boxSizing: "border-box", outline: "none", fontFamily: FONT,
    cursor: "pointer", appearance: "none",
    transition: "border-color 0.2s ease",
  };
}
