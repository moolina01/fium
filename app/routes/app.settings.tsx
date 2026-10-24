import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate, registerCarrierService } from "../shopify.server";
import db from "../db.server";
import { REGIONES, REGIONES_COMUNAS } from "../data/chile";
import { isCarrierRegistered } from "../lib/setup.server";
import { saveUberCredentials } from "../lib/uber-credentials.server";
import { PACKAGE_SIZES, toPackageSize } from "../lib/package-size";
import { FONT } from "../lib/theme";
import { normalizeChileanPhone } from "../lib/phone";
import { isValidEmail } from "../lib/email.server";
import { REMINDER_MINUTES, sendTestNotification } from "../lib/notifications.server";
import { WEEKDAYS, describeHours, hoursFromConfig, isTime } from "../lib/dispatch-hours";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [config, carrierRegistered] = await Promise.all([
    db.storeConfig.findUnique({ where: { shop: session.shop } }),
    isCarrierRegistered(session.shop, session.accessToken!),
  ]);
  // Correo sugerido para los avisos: el de la tienda en Shopify, si aún no eligió otro.
  let suggestedEmail: string | null = null;
  if (config?.notifyEmail == null) {
    try {
      const res = await admin.graphql(`#graphql
        query ShopEmail { shop { email } }`);
      suggestedEmail = (await res.json()).data?.shop?.email ?? null;
    } catch {
      // Sin sugerencia: la tienda lo escribe a mano.
    }
  }
  const uberConnected = !!(config?.uberClientId && config?.uberClientSecret && config?.uberCustomerId);
  return {
    // Nunca enviar el secret (ni cifrado) al navegador.
    config: config ? { ...config, uberClientSecret: null } : config,
    carrierRegistered,
    uberConnected,
    // Última vez que Shopify pidió tarifas a Fium en el checkout (ISO o null).
    carrierLiveAt: config?.lastRateRequestAt?.toISOString() ?? null,
    // URL que la tienda pega al crear el webhook en su dashboard de Uber Direct.
    uberWebhookUrl: `${process.env.SHOPIFY_APP_URL ?? ""}/webhooks/uber/delivery`,
    // Último aviso de Uber recibido (ISO o null): confirma que el webhook funciona.
    uberWebhookLiveAt: config?.lastUberWebhookAt?.toISOString() ?? null,
    suggestedEmail,
    reminderMinutes: REMINDER_MINUTES,
    hours: config ? hoursFromConfig(config) : hoursFromConfig({ dispatchDays: "", dispatchStart: "", dispatchCutoff: "" }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "address") {
    const data = {
      shop: session.shop,
      contactName: formData.get("contactName") as string,
      // Se guarda en E.164 (+569XXXXXXXX), el formato que exige Uber.
      phone: normalizeChileanPhone(formData.get("phone") as string) ?? "",
      address: formData.get("address") as string,
      region: formData.get("region") as string,
      comuna: formData.get("comuna") as string,
      zipCode: formData.get("zipCode") as string,
      pickupNotes: (formData.get("pickupNotes") as string) || null,
      packageSize: toPackageSize(formData.get("packageSize")),
    };
    const missing = Object.entries(data).filter(([k, v]) => k !== "shop" && k !== "pickupNotes" && !v);
    if (formData.get("phone") && !data.phone) return { error: "Teléfono inválido. Usa un celular chileno, ej: +56 9 1234 5678.", intent };
    if (missing.length > 0) return { error: "Completa todos los campos.", intent };
    await db.storeConfig.upsert({ where: { shop: session.shop }, update: data, create: data });
    return { success: "Dirección actualizada correctamente.", intent };
  }

  if (intent === "uber_credentials") {
    const result = await saveUberCredentials(session.shop, {
      uberClientId: (formData.get("uberClientId") as string) || "",
      uberCustomerId: (formData.get("uberCustomerId") as string) || "",
      uberClientSecret: (formData.get("uberClientSecret") as string) || "",
    });
    if ("error" in result) return { error: result.error, intent };
    return { success: "Cuenta de Uber Direct conectada correctamente.", intent };
  }

  if (intent === "vehicle") {
    const carOnly = formData.get("carOnly") === "true";
    await db.storeConfig.update({ where: { shop: session.shop }, data: { carOnly } });
    return { success: carOnly ? "Listo: tus envíos se pedirán siempre en auto." : "Listo: el vehículo se elegirá según el peso del pedido.", intent };
  }

  if (intent === "dispatch") {
    const autoDispatch = formData.get("autoDispatch") === "true";
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { autoDispatch },
    });
    return { success: autoDispatch ? "Modo automático activado." : "Modo manual activado.", intent };
  }

  if (intent === "hours") {
    const days = WEEKDAYS.map((d) => d.value).filter((d) => formData.get(`day${d}`) === "on");
    const start = (formData.get("dispatchStart") as string) || "";
    const cutoff = (formData.get("dispatchCutoff") as string) || "";
    if (days.length === 0) return { error: "Elige al menos un día de despacho.", intent };
    if (!isTime(start) || !isTime(cutoff)) return { error: "Revisa las horas: usa el formato 09:00.", intent };
    if (start >= cutoff) return { error: "La hora límite tiene que ser después de la hora de inicio.", intent };
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { dispatchDays: days.sort().join(","), dispatchStart: start, dispatchCutoff: cutoff },
    });
    return { success: `Horario guardado: ${describeHours({ days, start, cutoff })}.`, intent };
  }

  if (intent === "notifications" || intent === "test_email") {
    const email = ((formData.get("notifyEmail") as string) || "").trim();
    if (email && !isValidEmail(email)) return { error: "Ese correo no parece válido. Revísalo, ej: ventas@tutienda.cl.", intent };
    if (intent === "test_email") {
      if (!email) return { error: "Escribe un correo para mandar la prueba.", intent };
      const ok = await sendTestNotification(session.shop, email);
      return ok
        ? { success: `Te mandamos un correo de prueba a ${email}. Si no llega en unos minutos, revisa la carpeta de spam.`, intent }
        : { error: "No pudimos mandar el correo de prueba. Intenta de nuevo en unos minutos.", intent };
    }
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: {
        // "" (no null) = desactivado a propósito; null haría que se use el de Shopify.
        notifyEmail: email.toLowerCase(),
        notifyCanceled: formData.get("notifyCanceled") === "on",
        notifyNewOrder: formData.get("notifyNewOrder") === "on",
        notifyReminder: formData.get("notifyReminder") === "on",
      },
    });
    return { success: email ? "Avisos guardados." : "Avisos desactivados: no hay un correo configurado.", intent };
  }

  if (intent === "register_carrier") {
    const result = await registerCarrierService(session.shop, session.accessToken!);
    if (result.alreadyExists) return { success: "Carrier service ya estaba registrado.", intent };
    if (result.ok) return { success: "Carrier service registrado correctamente en Shopify.", intent };
    return { error: "Error al registrar el carrier service. Revisa la consola del servidor.", intent };
  }

  if (intent === "ack_carrier_activated") {
    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { carrierActivatedAck: true },
    });
    return { success: "¡Listo! Marcamos Fium como activado en tu checkout.", intent };
  }

  return { error: "Acción desconocida.", intent: "" };
};

const F = { fontFamily: FONT };

export default function Settings() {
  const { config, carrierRegistered, carrierLiveAt, uberConnected, uberWebhookUrl, uberWebhookLiveAt, suggestedEmail, reminderMinutes, hours } = useLoaderData<typeof loader>();
  const [copied, setCopied] = useState(false);
  function copyWebhookUrl() {
    navigator.clipboard?.writeText(uberWebhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";
  const [selectedRegion, setSelectedRegion] = useState(config?.region ?? "");
  const comunas = selectedRegion ? (REGIONES_COMUNAS[selectedRegion] ?? []) : [];

  // Si el action acaba de registrar el carrier, mostrar como registrado
  const isCarrierActive = carrierRegistered ||
    (actionData?.intent === "register_carrier" && !!actionData.success);

  // "Confirmado" = el merchant marcó "Ya lo activé" O Shopify ya pidió tarifas (señal en vivo).
  // Registrado solo (automático al instalar) NO cuenta como confirmado.
  const carrierConfirmed = !!carrierLiveAt || !!config?.carrierActivatedAck ||
    (actionData?.intent === "ack_carrier_activated" && !!actionData.success);

  return (
    <s-page heading="Configuración">
      <div style={{ display: "flex", flexDirection: "column", gap: "1px", ...F }}>

        {/* 1. Conexión con Uber Direct — credenciales propias de la tienda.
            Sin esto, Fium no puede cotizar ni despachar. */}
        <div style={{
          background: "white",
          borderRadius: "10px",
          border: uberConnected ? "1px solid #e5e7eb" : "2px solid #4B2BE0",
          overflow: "hidden",
          marginBottom: "12px",
          ...F,
        }}>
          <div style={{
            padding: "16px 20px",
            borderBottom: "1px solid #f3f4f6",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>
                Conexión con Uber Direct
              </div>
              <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "1px" }}>
                Credenciales de la cuenta de Uber Direct de tu tienda
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{
                width: "7px", height: "7px", borderRadius: "50%",
                background: uberConnected ? "#1D9E75" : "#DC2626", display: "inline-block",
              }} />
              <span style={{ fontSize: "12px", color: uberConnected ? "#1D9E75" : "#DC2626", fontWeight: "600" }}>
                {uberConnected ? "Conectado" : "Sin conectar"}
              </span>
            </div>
          </div>
          <div style={{ padding: "20px" }}>
            {actionData?.intent === "uber_credentials" && actionData.error && <Alert type="error">{actionData.error}</Alert>}
            {actionData?.intent === "uber_credentials" && actionData.success && <Alert type="success">{actionData.success}</Alert>}

            <div style={{
              background: "#fafafe", border: "1px solid #E4E2F0", borderRadius: "8px",
              padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: "#6b7280", lineHeight: "1.6",
            }}>
              Estas credenciales vienen del dashboard de <strong>Uber Direct</strong> (direct.uber.com),
              en <strong>Developer → Credentials</strong>. Tu cuenta debe tener una tarjeta cargada: Uber
              cobra cada envío directamente a tu cuenta.
            </div>

            <Form method="post">
              <input type="hidden" name="intent" value="uber_credentials" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <Field label="Client ID">
                  <input name="uberClientId" defaultValue={config?.uberClientId ?? ""} placeholder="kSoRrEVQ..." required style={inp} />
                </Field>
                <Field label="Customer ID">
                  <input name="uberCustomerId" defaultValue={config?.uberCustomerId ?? ""} placeholder="UUID de la organización" required style={inp} />
                </Field>
                <Field label="Client Secret" fullWidth>
                  <input
                    name="uberClientSecret"
                    type="password"
                    autoComplete="off"
                    placeholder={uberConnected ? "•••••••• (déjalo vacío para no cambiarlo)" : "Pega tu Client Secret"}
                    style={inp}
                  />
                </Field>
              </div>
              <div style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end" }}>
                <Btn type="submit" disabled={saving}>
                  {saving ? "Probando conexión..." : uberConnected ? "Probar y actualizar" : "Probar y conectar"}
                </Btn>
              </div>
            </Form>
          </div>
        </div>

        {/* 1b. Avisos de Uber (webhook). Uber no permite crearlo por API: la tienda lo
            crea en su dashboard. Sin esto el estado igual avanza (el dashboard consulta
            a Uber), pero solo mientras alguien tiene Fium abierto. */}
        {uberConnected && (
          <div style={{
            background: "white", borderRadius: "10px", overflow: "hidden", marginBottom: "12px",
            border: uberWebhookLiveAt ? "1px solid #e5e7eb" : "2px solid #4B2BE0", ...F,
          }}>
            <div style={{
              padding: "16px 20px", borderBottom: "1px solid #f3f4f6",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
            }}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>Avisos de estado de Uber</div>
                <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "1px" }}>
                  Para que el estado de tus envíos y de tus pedidos en Shopify se actualice al instante
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
                <span style={{
                  width: "7px", height: "7px", borderRadius: "50%", display: "inline-block",
                  background: uberWebhookLiveAt ? "#1D9E75" : "#EF9F27",
                }} />
                <span style={{ fontSize: "12px", fontWeight: "600", color: uberWebhookLiveAt ? "#1D9E75" : "#B45309" }}>
                  {uberWebhookLiveAt ? `Recibiendo avisos · ${relTime(uberWebhookLiveAt)}` : "Sin avisos todavía"}
                </span>
              </div>
            </div>
            <div style={{ padding: "20px", fontSize: "13px", color: "#374151", lineHeight: 1.7 }}>
              <ol style={{ margin: "0 0 14px", paddingLeft: "18px" }}>
                <li>Entra a <strong>direct.uber.com</strong> → <strong>Desarrollador</strong> → pestaña <strong>Webhooks</strong>.</li>
                <li>Haz clic en <strong>Crear webhook</strong> y pega esta URL:</li>
              </ol>
              <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
                <input readOnly value={uberWebhookUrl} onFocus={(e) => e.currentTarget.select()} style={{ ...inp, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }} />
                <button
                  type="button"
                  onClick={copyWebhookUrl}
                  style={{
                    flexShrink: 0, padding: "0 16px", borderRadius: "8px", cursor: "pointer",
                    border: "1px solid #4B2BE0", background: copied ? "#EEEDFE" : "white",
                    color: "#4B2BE0", fontSize: "13px", fontWeight: "600", ...F,
                  }}
                >
                  {copied ? "Copiada" : "Copiar"}
                </button>
              </div>
              <ol start={3} style={{ margin: 0, paddingLeft: "18px" }}>
                <li>En los tipos de eventos marca solo <strong>event.delivery_status</strong> y haz clic en <strong>Guardar</strong>.</li>
              </ol>
              <div style={{ fontSize: "12px", color: "#6b7280", marginTop: "12px" }}>
                {uberWebhookLiveAt
                  ? "Todo listo: Uber ya está avisando a Fium cada vez que cambia el estado de un envío."
                  : "Este indicador se pone en verde con el primer envío que cambie de estado. Mientras tanto, Fium consulta a Uber cada vez que abres el panel de envíos."}
              </div>
            </div>
          </div>
        )}

        {/* 2. Carrier service — prominente hasta que esté realmente activo en el checkout */}
        <div style={{
          background: "white",
          borderRadius: "10px",
          border: carrierConfirmed ? "1px solid #e5e7eb" : "2px solid #4B2BE0",
          overflow: "hidden",
          marginBottom: "12px",
          ...F,
        }}>
          <div style={{
            padding: "16px 20px",
            borderBottom: "1px solid #f3f4f6",
            display: "flex", alignItems: "center", justifyContent: "space-between",
          }}>
            <div>
              <div style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>
                Cotización en checkout
              </div>
              <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "1px" }}>
                Necesario para mostrar el precio de Uber Direct en el carrito
              </div>
            </div>
            {/* Pill de estado en 3 niveles: registrado (auto al instalar) NO es lo mismo
                que activo en el checkout. "Activo" solo cuando Shopify ya pidió tarifas. */}
            {(() => {
              const status = carrierConfirmed
                ? { color: "#1D9E75", label: "Activo" }
                : isCarrierActive
                  ? { color: "#D97706", label: "Falta zona de envío" }
                  : { color: "#DC2626", label: "Sin activar" };
              return (
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: status.color, display: "inline-block" }} />
                  <span style={{ fontSize: "12px", color: status.color, fontWeight: "600" }}>{status.label}</span>
                </div>
              );
            })()}
          </div>
          <div style={{ padding: "20px" }}>
            {actionData?.intent === "register_carrier" && actionData.error && <Alert type="error">{actionData.error}</Alert>}
            {actionData?.intent === "register_carrier" && actionData.success && <Alert type="success">{actionData.success}</Alert>}
            {actionData?.intent === "ack_carrier_activated" && actionData.success && <Alert type="success">{actionData.success}</Alert>}

            {!isCarrierActive ? (
              /* Caso raro: el carrier service no está registrado (normalmente se
                 registra solo al instalar). Hay que registrarlo primero. */
              <>
                <div style={{
                  background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px",
                  padding: "10px 14px", marginBottom: "16px", fontSize: "13px", color: "#b91c1c", lineHeight: "1.6",
                }}>
                  ⚠️ Fium <strong>no está registrado</strong> como servicio de envío. Mientras no lo actives,
                  <strong> las cotizaciones no aparecerán en el carrito</strong>.
                </div>
                <ol style={{ margin: "0 0 16px", paddingLeft: "18px", fontSize: "13px", color: "#374151", lineHeight: "1.7" }}>
                  <li>Presiona el botón de abajo para registrar Fium como servicio de envío.</li>
                  <li>En Shopify ve a <strong>Configuración → Envío y entrega</strong> y agrega <strong>Fium</strong> a tu zona de envío.</li>
                </ol>
                <Form method="post">
                  <input type="hidden" name="intent" value="register_carrier" />
                  <Btn type="submit" disabled={saving}>
                    {saving ? "Activando..." : "Registrar Fium en el checkout"}
                  </Btn>
                </Form>
              </>
            ) : carrierConfirmed ? (
              /* Confirmado: el merchant lo marcó como activado o Shopify ya pidió tarifas */
              <div style={{
                background: "#E6F7F2", border: "1px solid #A7E6C8", borderRadius: "8px",
                padding: "12px 14px", color: "#0F7355", fontSize: "13px", lineHeight: "1.6",
              }}>
                ✅ <strong>Fium está activo en tu checkout.</strong>{" "}
                {carrierLiveAt
                  ? `Shopify pidió cotizaciones de Fium ${relTime(carrierLiveAt)}.`
                  : "Lo marcaste como activado. Te lo confirmaremos automáticamente en cuanto Shopify pida la primera cotización."}
              </div>
            ) : (
              /* Registrado pero el merchant aún no confirmó que lo agregó a su zona de envío */
              <div style={{ fontSize: "13px", color: "#6b7280", lineHeight: "1.7" }}>
                <div style={{
                  background: "#FEF9EC", border: "1px solid #FDE68A", borderRadius: "8px",
                  padding: "10px 14px", marginBottom: "12px", color: "#92400E", fontSize: "13px", lineHeight: "1.6",
                }}>
                  ⏳ Fium está <strong>registrado</strong>, pero falta <strong>agregarlo a tu zona de envío</strong> para
                  que aparezca en el checkout.
                </div>
                <p style={{ margin: "0 0 8px", color: "#374151" }}>Cómo activarlo (solo se hace una vez):</p>
                <ol style={{ margin: "0 0 16px", paddingLeft: "18px", color: "#374151" }}>
                  <li>En Shopify ve a <strong>Configuración → Envío y entrega</strong>.</li>
                  <li>En tu zona de envío, agrega la tarifa <strong>Fium</strong> (aparece en la lista de transportistas).</li>
                  <li>Vuelve aquí y presiona <strong>“Ya lo activé”</strong>.</li>
                </ol>
                <Form method="post">
                  <input type="hidden" name="intent" value="ack_carrier_activated" />
                  <Btn type="submit" disabled={saving}>
                    {saving ? "Guardando..." : "Ya lo activé en Shopify"}
                  </Btn>
                </Form>
              </div>
            )}

            {/* Cobertura + respaldo */}
            <div style={{
              marginTop: "16px", padding: "12px 14px",
              background: "#fafafe", border: "1px solid #E4E2F0",
              borderRadius: "8px", fontSize: "12px", color: "#6b7280", lineHeight: "1.6",
            }}>
              <div style={{ fontWeight: "600", color: "#374151", marginBottom: "2px" }}>
                📍 Cobertura de entrega rápida: ~5 km
              </div>
              Fium solo cotiza envíos dentro de un radio aproximado de <strong>5 km</strong> desde tu punto
              de despacho. Fuera de ese radio, Fium <strong>no aparece</strong> en el checkout.
              Por eso, mantén siempre otra opción de envío (una tarifa plana, otra empresa o retiro en tienda)
              en tu zona de envío — así los clientes fuera de cobertura igual pueden completar su compra.
            </div>
          </div>
        </div>

        {/* 3. Punto de despacho */}
        <Section
          title="Punto de despacho"
          description="Dirección donde Uber Direct recoge tus pedidos"
        >
          {actionData?.intent === "address" && actionData.error && <Alert type="error">{actionData.error}</Alert>}
          {actionData?.intent === "address" && actionData.success && <Alert type="success">{actionData.success}</Alert>}
          <Form method="post">
            <input type="hidden" name="intent" value="address" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <Field label="Nombre de contacto">
                <input name="contactName" defaultValue={config?.contactName ?? ""} placeholder="Juan Pérez" required style={inp} />
              </Field>
              <Field label="Teléfono">
                <input name="phone" defaultValue={config?.phone ?? ""} placeholder="+56 9 1234 5678" required style={inp} />
              </Field>
              <Field label="Dirección" fullWidth>
                <input name="address" defaultValue={config?.address ?? ""} placeholder="Av. Providencia 1234" required style={inp} />
              </Field>
              <Field label="Región">
                <select name="region" required style={inp} value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)}>
                  <option value="">Seleccionar...</option>
                  {REGIONES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="Comuna">
                <select name="comuna" required style={inp} disabled={!selectedRegion} defaultValue={config?.comuna ?? ""}>
                  <option value="">{selectedRegion ? "Seleccionar..." : "Elige región primero"}</option>
                  {comunas.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Código postal">
                <input name="zipCode" defaultValue={config?.zipCode ?? ""} placeholder="7500000" required style={inp} />
              </Field>
              <Field label="Instrucciones para el retiro (opcional)" fullWidth>
                <input name="pickupNotes" defaultValue={config?.pickupNotes ?? ""} placeholder="Ej: Tocar timbre, retirar en local 5" style={inp} />
              </Field>
              <Field label="Tamaño de paquete por defecto" fullWidth>
                <select name="packageSize" defaultValue={config?.packageSize ?? "medium"} style={inp}>
                  {PACKAGE_SIZES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end" }}>
              <Btn type="submit" disabled={saving}>{saving ? "Guardando..." : "Guardar cambios"}</Btn>
            </div>
          </Form>
        </Section>

        <Section
          title="Vehículo para tus envíos"
          description="Qué tipo de vehículo le pide Fium a Uber"
        >
          {actionData?.intent === "vehicle" && actionData?.success && <Alert type="success">{actionData?.success}</Alert>}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {([
              { value: "false", label: "Según el peso del pedido", badge: "Recomendado", desc: "Pedidos livianos pueden ir en moto (más rápido); los de más de 11 kg van en auto." },
              { value: "true",  label: "Siempre auto", badge: null, desc: "Todos los pedidos se piden en auto. Ideal si vendes productos pesados o voluminosos." },
            ] as const).map((opt) => {
              const isSelected = String(config?.carOnly ?? false) === opt.value;
              return (
                <Form key={opt.value} method="post">
                  <input type="hidden" name="intent" value="vehicle" />
                  <input type="hidden" name="carOnly" value={opt.value} />
                  <button type="submit" aria-pressed={isSelected} style={{
                    width: "100%", textAlign: "left", cursor: "pointer",
                    background: isSelected ? "#fafafe" : "white",
                    border: `1.5px solid ${isSelected ? "#4B2BE0" : "#e5e7eb"}`,
                    borderRadius: "8px", padding: "14px 16px",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: "12px", ...F,
                  }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "14px", fontWeight: "600", color: "#111827", marginBottom: "2px" }}>
                        {opt.label}
                        {opt.badge && (
                          <span style={{ fontSize: "11px", fontWeight: 600, color: "#4B2BE0", background: "#EEEDFE", borderRadius: "99px", padding: "1px 8px" }}>
                            {opt.badge}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "13px", color: "#6b7280" }}>{opt.desc}</div>
                    </div>
                    <div style={{
                      width: "18px", height: "18px", borderRadius: "50%", flexShrink: 0,
                      border: `2px solid ${isSelected ? "#4B2BE0" : "#d1d5db"}`,
                      background: isSelected ? "#4B2BE0" : "white",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {isSelected && <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "white" }} />}
                    </div>
                  </button>
                </Form>
              );
            })}
          </div>
          <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "10px", lineHeight: 1.5 }}>
            Uber solo asegura un auto cuando el paquete se marca como Extra grande, así que con “Siempre auto” Fium marca todos los pedidos así. El precio que ve tu cliente en el checkout no cambia.
          </div>
        </Section>

        <Section
          title="Horario de despacho"
          description="Cuándo despachas pedidos con Uber, en hora de Chile"
        >
          {actionData?.intent === "hours" && actionData.error && <Alert type="error">{actionData.error}</Alert>}
          {actionData?.intent === "hours" && actionData.success && <Alert type="success">{actionData.success}</Alert>}
          <Form method="post">
            <input type="hidden" name="intent" value="hours" />
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                <legend style={{ fontSize: "12px", fontWeight: 600, color: "#374151", marginBottom: "8px", padding: 0 }}>Días de despacho</legend>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {WEEKDAYS.map((d) => (
                    <label key={d.value} htmlFor={`day${d.value}`} style={{
                      display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer",
                      border: "1.5px solid #e5e7eb", borderRadius: "7px", padding: "6px 10px",
                      fontSize: "13px", color: "#111827",
                    }}>
                      <input id={`day${d.value}`} name={`day${d.value}`} type="checkbox" defaultChecked={hours.days.includes(d.value)} style={{ accentColor: "#4B2BE0" }} />
                      {d.short}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px" }}>
                <Field label="Despachas desde las">
                  <input id="dispatchStart" name="dispatchStart" type="time" defaultValue={hours.start} required style={inp} />
                </Field>
                <Field label="Último pedido del día a las">
                  <input id="dispatchCutoff" name="dispatchCutoff" type="time" defaultValue={hours.cutoff} required style={inp} />
                </Field>
              </div>
              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.6 }}>
                Fium aparece en el checkout solo dentro de este horario, como <strong>“Fium Express — llega en 1 a 3 horas”</strong>. Fuera de él (de noche, o en días sin despacho) no se ofrece, para no prometer un envío que no alcanzas a despachar. Pon como hora del último pedido la última hora en que todavía puedes preparar y despachar.
              </div>
              <div><Btn type="submit" disabled={saving}>Guardar horario</Btn></div>
            </div>
          </Form>
        </Section>

        <Section
          title="Avisos por correo"
          description="Te avisamos cuando un pedido necesita que hagas algo"
        >
          {(actionData?.intent === "notifications" || actionData?.intent === "test_email") && actionData.error && <Alert type="error">{actionData.error}</Alert>}
          {(actionData?.intent === "notifications" || actionData?.intent === "test_email") && actionData.success && <Alert type="success">{actionData.success}</Alert>}
          <Form method="post">
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <Field label="Correo donde recibes los avisos">
                <input
                  id="notifyEmail" name="notifyEmail" type="email" autoComplete="email"
                  defaultValue={config?.notifyEmail ?? suggestedEmail ?? ""}
                  placeholder="despachos@tutienda.cl" style={inp}
                />
                <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "6px", lineHeight: 1.5 }}>
                  Idealmente, el de quien gestiona los despachos. Si lo dejas vacío, no te enviaremos avisos.
                </div>
              </Field>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {([
                  { name: "notifyCanceled", label: "Envío con problemas", desc: "Uber canceló o devolvió un envío, o no se pudo crear. Recomendado: el cliente pagó y no recibió su pedido.", checked: config?.notifyCanceled ?? true },
                  { name: "notifyReminder", label: "Pedido sin despachar", desc: `Si un pedido lleva ${reminderMinutes} minutos sin despachar, te mandamos un recordatorio (uno por pedido).`, checked: config?.notifyReminder ?? true },
                  { name: "notifyNewOrder", label: "Cada pedido nuevo", desc: "Un correo por cada pedido pagado con envío Uber. Útil si no tienes Fium abierto, pero llegan muchos.", checked: config?.notifyNewOrder ?? false },
                ] as const).map((opt) => (
                  <label key={opt.name} htmlFor={opt.name} style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: "10px", alignItems: "start", cursor: "pointer" }}>
                    <input id={opt.name} name={opt.name} type="checkbox" defaultChecked={opt.checked} style={{ marginTop: "3px", accentColor: "#4B2BE0" }} />
                    <span style={{ fontSize: "14px", fontWeight: 600, color: "#111827" }}>{opt.label}</span>
                    <span style={{ gridColumn: 2, fontSize: "13px", color: "#6b7280", lineHeight: 1.5 }}>{opt.desc}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button type="submit" name="intent" value="notifications" disabled={saving} style={btnStyle("primary", saving)}>Guardar avisos</button>
                <button type="submit" name="intent" value="test_email" disabled={saving} style={btnStyle("secondary", saving)}>Mandar correo de prueba</button>
              </div>
            </div>
          </Form>
        </Section>

        {/* 4. Modo de despacho — OCULTO temporalmente: aún no lanzamos la elección
            automático/manual. El despacho sigue en "manual" por defecto (autoDispatch=false).
            Revertir: cambiar `{false && (` por `{true && (` o quitar el wrapper. */}
        {false && (
        <Section
          title="Modo de despacho"
          description="Cómo se crean los envíos cuando llega una orden"
        >
          {actionData?.intent === "dispatch" && actionData?.success && <Alert type="success">{actionData?.success}</Alert>}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {([
              { value: "false", label: "Manual", desc: "Las órdenes aparecen en el dashboard y tú decides cuándo crear el envío." },
              { value: "true",  label: "Automático", desc: "El envío se crea automáticamente al recibir el pago, sin intervención." },
            ] as const).map((opt) => {
              const isSelected = String(config?.autoDispatch ?? false) === opt.value;
              return (
                <Form key={opt.value} method="post">
                  <input type="hidden" name="intent" value="dispatch" />
                  <input type="hidden" name="autoDispatch" value={opt.value} />
                  <button type="submit" style={{
                    width: "100%", textAlign: "left", cursor: "pointer",
                    background: isSelected ? "#fafafe" : "white",
                    border: `1.5px solid ${isSelected ? "#4B2BE0" : "#e5e7eb"}`,
                    borderRadius: "8px", padding: "14px 16px",
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: "12px", ...F,
                  }}>
                    <div>
                      <div style={{ fontSize: "14px", fontWeight: "600", color: "#111827", marginBottom: "2px" }}>
                        {opt.label}
                      </div>
                      <div style={{ fontSize: "13px", color: "#6b7280" }}>{opt.desc}</div>
                    </div>
                    <div style={{
                      width: "18px", height: "18px", borderRadius: "50%", flexShrink: 0,
                      border: `2px solid ${isSelected ? "#4B2BE0" : "#d1d5db"}`,
                      background: isSelected ? "#4B2BE0" : "white",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {isSelected && <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "white" }} />}
                    </div>
                  </button>
                </Form>
              );
            })}
          </div>
        </Section>
        )}

      </div>
    </s-page>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: "white", borderRadius: "10px",
      border: "1px solid #e5e7eb", overflow: "hidden",
      marginBottom: "12px",
      fontFamily: FONT,
    }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ fontSize: "14px", fontWeight: "600", color: "#111827" }}>{title}</div>
        <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "1px" }}>{description}</div>
      </div>
      <div style={{ padding: "20px" }}>{children}</div>
    </div>
  );
}

function Field({ label, children, fullWidth }: { label: string; children: React.ReactNode; fullWidth?: boolean }) {
  return (
    <div style={{ gridColumn: fullWidth ? "1 / -1" : undefined }}>
      <label style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "5px", letterSpacing: "0.1px" }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Alert({ type, children }: { type: "error" | "success"; children: React.ReactNode }) {
  const isError = type === "error";
  return (
    <div style={{
      borderLeft: `3px solid ${isError ? "#dc2626" : "#4B2BE0"}`,
      background: isError ? "#fef2f2" : "#fafafe",
      borderRadius: "0 6px 6px 0",
      padding: "10px 14px",
      fontSize: "13px",
      color: isError ? "#dc2626" : "#4B2BE0",
      marginBottom: "16px",
    }}>
      {children}
    </div>
  );
}

function Btn({ children, disabled, type, variant = "primary" }: {
  children: React.ReactNode;
  disabled?: boolean;
  type?: "submit" | "button";
  variant?: "primary" | "secondary";
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      style={btnStyle(variant, disabled)}
    >
      {children}
    </button>
  );
}

function btnStyle(variant: "primary" | "secondary", disabled?: boolean): React.CSSProperties {
  return {
    padding: "8px 18px",
    background: variant === "primary" ? (disabled ? "#9b85ec" : "#4B2BE0") : "white",
    color: variant === "primary" ? "white" : "#374151",
    border: variant === "primary" ? "none" : "1.5px solid #e5e7eb",
    borderRadius: "7px", fontSize: "13px", fontWeight: "600",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: FONT,
  };
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "hace instantes";
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  return `hace ${Math.floor(hrs / 24)} d`;
}

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 11px",
  border: "1.5px solid #e5e7eb", borderRadius: "7px",
  fontSize: "13px", color: "#111827", background: "white",
  boxSizing: "border-box", outline: "none",
  fontFamily: FONT,
};
