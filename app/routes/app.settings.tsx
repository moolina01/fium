import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate, registerCarrierService } from "../shopify.server";
import db from "../db.server";
import { REGIONES, REGIONES_COMUNAS } from "../data/chile";
import { isCarrierRegistered } from "../lib/setup.server";
import { saveUberCredentials } from "../lib/uber-credentials.server";
import { PACKAGE_SIZES, toPackageSize } from "../lib/package-size";
import { FONT, colors as C } from "../lib/theme";
import { normalizeChileanPhone } from "../lib/phone";
import { isValidEmail } from "../lib/email.server";
import { REMINDER_MINUTES, sendTestNotification } from "../lib/notifications.server";
import { WEEKDAYS, describeHours, hoursFromConfig, isTime } from "../lib/dispatch-hours";
import { toUndeliverableAction } from "../lib/test-scenarios";

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
    };
    const missing = Object.entries(data).filter(([k, v]) => k !== "shop" && k !== "pickupNotes" && !v);
    if (formData.get("phone") && !data.phone) return { error: "Teléfono inválido. Usa un celular chileno, ej: +56 9 1234 5678.", intent };
    if (missing.length > 0) return { error: "Completa todos los campos.", intent };
    await db.storeConfig.upsert({ where: { shop: session.shop }, update: data, create: data });
    return { success: "Punto de retiro guardado.", intent };
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

  if (intent === "shipping") {
    const saved = await db.storeConfig.updateMany({
      where: { shop: session.shop },
      data: {
        carOnly: formData.get("carOnly") === "true",
        packageSize: toPackageSize(formData.get("packageSize")),
        undeliverableAction: toUndeliverableAction(formData.get("undeliverableAction")),
      },
    });
    if (saved.count === 0) return { error: "Primero guarda tu punto de retiro.", intent };
    return { success: "Preferencias de envío guardadas.", intent };
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
  const savingIntent = saving ? navigation.formData?.get("intent") : null;
  const [selectedRegion, setSelectedRegion] = useState(config?.region ?? "");
  const comunas = selectedRegion ? (REGIONES_COMUNAS[selectedRegion] ?? []) : [];

  // Mensaje de resultado de la última acción, junto a la tarjeta que la hizo.
  const feedback = (...intents: string[]) =>
    actionData && intents.includes(actionData.intent) ? (
      <>
        {"error" in actionData && actionData.error && <Notice tone="critical">{actionData.error}</Notice>}
        {"success" in actionData && actionData.success && <Notice tone="success">{actionData.success}</Notice>}
      </>
    ) : null;

  // Si el action acaba de registrar el carrier, mostrar como registrado
  const isCarrierActive = carrierRegistered ||
    (actionData?.intent === "register_carrier" && "success" in actionData && !!actionData.success);

  // "Confirmado" = el merchant marcó "Ya lo activé" O Shopify ya pidió tarifas (señal en vivo).
  // Registrado solo (automático al instalar) NO cuenta como confirmado.
  const carrierConfirmed = !!carrierLiveAt || !!config?.carrierActivatedAck ||
    (actionData?.intent === "ack_carrier_activated" && "success" in actionData && !!actionData.success);

  const carrierStatus: { tone: Tone; label: string } = carrierConfirmed
    ? { tone: "success", label: "Activo" }
    : isCarrierActive
      ? { tone: "warning", label: "Falta zona de envío" }
      : { tone: "critical", label: "Sin activar" };

  return (
    <s-page heading="Configuración">
      <style>{CSS}</style>
      <div className="st-wrap" style={F}>

        {/* ─── 1. Conexiones ─────────────────────────────────────────────── */}
        <Group
          title="Conexiones"
          description="Lo que Fium necesita para cotizar en tu checkout y crear envíos con Uber Direct."
        >
          <Card
            title="Cuenta de Uber Direct"
            description="Uber cobra cada envío directamente a esta cuenta."
            badge={uberConnected ? { tone: "success", label: "Conectada" } : { tone: "critical", label: "Sin conectar" }}
          >
            {feedback("uber_credentials")}
            <p className="st-help" style={{ margin: "0 0 16px" }}>
              Encuentra estos datos en direct.uber.com, sección Desarrollador (Developer), pestaña Credenciales.
              La cuenta debe tener un medio de pago activo.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="uber_credentials" />
              <div className="st-grid2">
                <Field label="Client ID" htmlFor="uberClientId">
                  <input id="uberClientId" name="uberClientId" defaultValue={config?.uberClientId ?? ""} required className="st-input" />
                </Field>
                <Field label="Customer ID" htmlFor="uberCustomerId">
                  <input id="uberCustomerId" name="uberCustomerId" defaultValue={config?.uberCustomerId ?? ""} required className="st-input" />
                </Field>
                <Field label="Client Secret" htmlFor="uberClientSecret" fullWidth
                  help={uberConnected ? "Déjalo vacío para mantener el actual." : undefined}>
                  <input
                    id="uberClientSecret" name="uberClientSecret" type="password" autoComplete="off"
                    placeholder={uberConnected ? "••••••••" : ""} className="st-input"
                  />
                </Field>
              </div>
              <Actions>
                <Btn type="submit" disabled={saving}>
                  {savingIntent === "uber_credentials" ? "Probando conexión..." : uberConnected ? "Probar y actualizar" : "Probar y conectar"}
                </Btn>
              </Actions>
            </Form>
          </Card>

          {/* Uber no permite crear el webhook por API: la tienda lo crea en su dashboard.
              Sin él el estado igual avanza (el panel consulta a Uber), pero solo con Fium abierto. */}
          {uberConnected && (
            <Card
              title="Actualizaciones de estado de Uber"
              description="Para que tus envíos y tus pedidos en Shopify se actualicen al instante."
              badge={uberWebhookLiveAt
                ? { tone: "success", label: `Recibiendo · ${relTime(uberWebhookLiveAt)}` }
                : { tone: "warning", label: "Sin actualizaciones aún" }}
            >
              <ol className="st-steps">
                <li>En direct.uber.com, entra a Desarrollador y luego a la pestaña Webhooks.</li>
                <li>Elige Crear webhook y pega esta URL:</li>
              </ol>
              <div style={{ display: "flex", gap: "8px", margin: "10px 0 12px" }}>
                <input
                  readOnly value={uberWebhookUrl} aria-label="URL del webhook"
                  onFocus={(e) => e.currentTarget.select()}
                  className="st-input" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }}
                />
                <Btn type="button" variant="secondary" onClick={copyWebhookUrl}>{copied ? "Copiada" : "Copiar"}</Btn>
              </div>
              <ol className="st-steps" start={3}>
                <li>En tipos de evento, marca solo event.delivery_status y guarda.</li>
              </ol>
              <p className="st-help">
                {uberWebhookLiveAt
                  ? "Uber está informando a Fium cada cambio de estado de tus envíos."
                  : "El estado cambia a Recibiendo con el primer envío que avance. Mientras tanto, Fium consulta a Uber cada vez que abres el panel."}
              </p>
            </Card>
          )}

          <Card
            title="Fium en el checkout"
            description="La tarifa Fium Express que ven tus clientes al pagar."
            badge={carrierStatus}
          >
            {feedback("register_carrier", "ack_carrier_activated")}
            {!isCarrierActive ? (
              /* Caso raro: el carrier service no está registrado (normalmente se registra solo al instalar). */
              <>
                <Notice tone="critical">
                  Fium no está registrado como servicio de envío, así que no aparece en tu checkout.
                </Notice>
                <ol className="st-steps">
                  <li>Registra Fium con el botón de abajo.</li>
                  <li>En Shopify, ve a Configuración, Envío y entrega, y agrega Fium a tu zona de envío.</li>
                </ol>
                <Form method="post">
                  <input type="hidden" name="intent" value="register_carrier" />
                  <Actions>
                    <Btn type="submit" disabled={saving}>{savingIntent === "register_carrier" ? "Registrando..." : "Registrar Fium"}</Btn>
                  </Actions>
                </Form>
              </>
            ) : carrierConfirmed ? (
              <p className="st-text" style={{ margin: 0 }}>
                {carrierLiveAt
                  ? `Fium está activo. Shopify pidió la última cotización ${relTime(carrierLiveAt)}.`
                  : "Lo marcaste como activado. Se confirmará solo cuando Shopify pida la primera cotización."}
              </p>
            ) : (
              /* Registrado pero falta agregarlo a la zona de envío */
              <>
                <Notice tone="warning">
                  Fium está registrado, pero falta agregarlo a tu zona de envío para que aparezca en el checkout.
                </Notice>
                <ol className="st-steps">
                  <li>En Shopify, ve a Configuración, Envío y entrega.</li>
                  <li>En tu zona de envío, agrega la tarifa Fium (aparece en la lista de transportistas).</li>
                  <li>Vuelve aquí y confirma.</li>
                </ol>
                <Form method="post">
                  <input type="hidden" name="intent" value="ack_carrier_activated" />
                  <Actions>
                    <Btn type="submit" disabled={saving}>{savingIntent === "ack_carrier_activated" ? "Guardando..." : "Ya lo agregué en Shopify"}</Btn>
                  </Actions>
                </Form>
              </>
            )}
            <div className="st-divider" />
            <p className="st-help" style={{ margin: 0 }}>
              <strong className="st-strong">Cobertura.</strong> Fium cotiza envíos dentro de unos 5 km desde tu punto de retiro;
              fuera de ese radio no aparece. Mantén otra opción de envío en tu zona (tarifa plana, otra empresa o retiro en
              tienda) para que esos clientes igual puedan comprar.
            </p>
          </Card>
        </Group>

        {/* ─── 2. Retiro y horario ───────────────────────────────────────── */}
        <Group
          title="Retiro y horario"
          description="Dónde y cuándo el conductor de Uber retira tus pedidos."
        >
          <Card title="Punto de retiro" description="El conductor llega a esta dirección y pregunta por este contacto.">
            {feedback("address")}
            <Form method="post">
              <input type="hidden" name="intent" value="address" />
              <div className="st-grid2">
                <Field label="Nombre de contacto" htmlFor="contactName">
                  <input id="contactName" name="contactName" defaultValue={config?.contactName ?? ""} placeholder="Juan Pérez" required className="st-input" />
                </Field>
                <Field label="Teléfono" htmlFor="phone">
                  <input id="phone" name="phone" type="tel" defaultValue={config?.phone ?? ""} placeholder="+56 9 1234 5678" required className="st-input" />
                </Field>
                <Field label="Dirección" htmlFor="address" fullWidth>
                  <input id="address" name="address" defaultValue={config?.address ?? ""} placeholder="Av. Providencia 1234" required className="st-input" />
                </Field>
                <Field label="Región" htmlFor="region">
                  <select id="region" name="region" required className="st-input" value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)}>
                    <option value="">Seleccionar</option>
                    {REGIONES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </Field>
                <Field label="Comuna" htmlFor="comuna">
                  <select id="comuna" name="comuna" required className="st-input" disabled={!selectedRegion} defaultValue={config?.comuna ?? ""}>
                    <option value="">{selectedRegion ? "Seleccionar" : "Elige primero la región"}</option>
                    {comunas.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label="Código postal" htmlFor="zipCode">
                  <input id="zipCode" name="zipCode" defaultValue={config?.zipCode ?? ""} placeholder="7500000" required className="st-input" />
                </Field>
                <Field label="Instrucciones para el retiro" htmlFor="pickupNotes" fullWidth help="Opcional. Ej: tocar timbre, retirar en local 5.">
                  <input id="pickupNotes" name="pickupNotes" defaultValue={config?.pickupNotes ?? ""} className="st-input" />
                </Field>
              </div>
              <Actions>
                <Btn type="submit" disabled={saving}>{savingIntent === "address" ? "Guardando..." : "Guardar"}</Btn>
              </Actions>
            </Form>
          </Card>

          <Card title="Horario de despacho" description="En hora de Chile. Fium solo aparece en el checkout dentro de este horario.">
            {feedback("hours")}
            <Form method="post">
              <input type="hidden" name="intent" value="hours" />
              <fieldset className="st-fieldset">
                <legend className="st-label">Días de despacho</legend>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {WEEKDAYS.map((d) => (
                    <label key={d.value} htmlFor={`day${d.value}`} className="st-day">
                      <input id={`day${d.value}`} name={`day${d.value}`} type="checkbox" defaultChecked={hours.days.includes(d.value)} />
                      {d.short}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="st-grid2" style={{ marginTop: "16px" }}>
                <Field label="Desde las" htmlFor="dispatchStart">
                  <input id="dispatchStart" name="dispatchStart" type="time" defaultValue={hours.start} required className="st-input" />
                </Field>
                <Field label="Último pedido a las" htmlFor="dispatchCutoff" help="La última hora en que aún alcanzas a preparar y despachar.">
                  <input id="dispatchCutoff" name="dispatchCutoff" type="time" defaultValue={hours.cutoff} required className="st-input" />
                </Field>
              </div>
              <p className="st-help">
                Dentro del horario, el checkout muestra “Fium Express — llega en 1 a 3 horas”. Fuera de él (de noche o en
                días sin despacho) Fium no se ofrece, para no prometer un envío que no alcanzas a despachar.
              </p>
              <Actions>
                <Btn type="submit" disabled={saving}>{savingIntent === "hours" ? "Guardando..." : "Guardar"}</Btn>
              </Actions>
            </Form>
          </Card>
        </Group>

        {/* ─── 3. Envíos ─────────────────────────────────────────────────── */}
        <Group
          title="Envíos"
          description="Cómo Fium le pide cada envío a Uber. El precio que ve tu cliente en el checkout no cambia."
        >
          <Card title="Preferencias de envío">
            {feedback("shipping")}
            <Form method="post">
              <input type="hidden" name="intent" value="shipping" />

              <fieldset className="st-fieldset">
                <legend className="st-label">Vehículo</legend>
                <div className="st-choices">
                  <Choice name="carOnly" value="false" defaultChecked={!config?.carOnly} label="Según el peso del pedido" recommended
                    desc="Los pedidos livianos pueden ir en moto, que suele ser más rápido. Sobre 11,34 kg van siempre en auto." />
                  <Choice name="carOnly" value="true" defaultChecked={!!config?.carOnly} label="Siempre en auto"
                    desc="Para productos pesados, voluminosos o frágiles. Fium marca todos los pedidos como Extra grande, el único tamaño con el que Uber asegura un auto." />
                </div>
              </fieldset>

              <div className="st-divider" />

              <Field label="Tamaño de paquete por defecto" htmlFor="packageSize"
                help="Se usa cuando los productos del pedido no tienen peso cargado en Shopify. Si tienen peso, Fium calcula el tamaño solo.">
                <select id="packageSize" name="packageSize" defaultValue={config?.packageSize ?? "medium"} className="st-input">
                  {PACKAGE_SIZES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label} — {s.hint}</option>
                  ))}
                </select>
              </Field>

              <div className="st-divider" />

              <fieldset className="st-fieldset">
                <legend className="st-label">Si el cliente no está</legend>
                <p className="st-help" style={{ margin: "0 0 10px" }}>
                  Antes de decidir, el conductor intenta contactar al cliente por teléfono.
                </p>
                <div className="st-choices">
                  <Choice name="undeliverableAction" value="leave_at_door"
                    defaultChecked={toUndeliverableAction(config?.undeliverableAction) === "leave_at_door"}
                    label="Dejarlo en la puerta" recommended
                    desc="El conductor deja el pedido en la puerta y toma una foto como prueba de entrega. No hay viaje de vuelta, pero el pedido queda sin nadie que lo reciba." />
                  <Choice name="undeliverableAction" value="return"
                    defaultChecked={toUndeliverableAction(config?.undeliverableAction) === "return"}
                    label="Traerlo de vuelta a tu tienda"
                    desc="Para productos de alto valor. Uber cobra el viaje de vuelta y luego coordinas con el cliente un nuevo envío o el reembolso." />
                </div>
              </fieldset>

              <Actions>
                <Btn type="submit" disabled={saving}>{savingIntent === "shipping" ? "Guardando..." : "Guardar"}</Btn>
              </Actions>
            </Form>
          </Card>
        </Group>

        {/* ─── 4. Notificaciones ─────────────────────────────────────────── */}
        <Group
          title="Notificaciones"
          description="Correos para enterarte de lo que necesita tu atención, aunque no tengas Fium abierto."
        >
          <Card title="Avisos por correo">
            {feedback("notifications", "test_email")}
            <Form method="post">
              <Field label="Correo de avisos" htmlFor="notifyEmail"
                help="Idealmente, el de quien gestiona los despachos. Si lo dejas vacío, no se envían avisos.">
                <input
                  id="notifyEmail" name="notifyEmail" type="email" autoComplete="email"
                  defaultValue={config?.notifyEmail ?? suggestedEmail ?? ""}
                  placeholder="despachos@tutienda.cl" className="st-input"
                />
              </Field>
              <div className="st-divider" />
              <fieldset className="st-fieldset">
                <legend className="st-label">Qué avisos recibir</legend>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {([
                    { name: "notifyCanceled", label: "Envío con problemas", desc: "Uber canceló o devolvió un envío, o no se pudo crear. El cliente pagó y aún no recibe su pedido.", checked: config?.notifyCanceled ?? true },
                    { name: "notifyReminder", label: "Pedido sin despachar", desc: `Un recordatorio si un pedido lleva ${reminderMinutes} minutos sin despachar dentro del horario.`, checked: config?.notifyReminder ?? true },
                    { name: "notifyNewOrder", label: "Cada pedido nuevo", desc: "Un correo por cada pedido pagado con Fium Express. Útil si no tienes Fium abierto, pero son muchos correos.", checked: config?.notifyNewOrder ?? false },
                  ] as const).map((opt) => (
                    <label key={opt.name} htmlFor={opt.name} className="st-check">
                      <input id={opt.name} name={opt.name} type="checkbox" defaultChecked={opt.checked} />
                      <span className="st-choice-title">{opt.label}</span>
                      <span className="st-choice-desc">{opt.desc}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Actions>
                <Btn type="submit" name="intent" value="test_email" variant="secondary" disabled={saving}>
                  {savingIntent === "test_email" ? "Enviando..." : "Enviar correo de prueba"}
                </Btn>
                <Btn type="submit" name="intent" value="notifications" disabled={saving}>
                  {savingIntent === "notifications" ? "Guardando..." : "Guardar"}
                </Btn>
              </Actions>
            </Form>
          </Card>
        </Group>

        {/* Modo de despacho (manual/automático) — OCULTO: aún no se lanza la elección.
            El despacho sigue en manual (autoDispatch=false). El action "dispatch" sigue
            disponible para cuando se vuelva a mostrar. */}

      </div>
    </s-page>
  );
}

// ─── Componentes ──────────────────────────────────────────────────────────

type Tone = "success" | "warning" | "critical";

const CSS = `
.st-wrap { display: flex; flex-direction: column; max-width: 1040px; margin: 0 auto; padding-bottom: 32px; color: ${C.text}; }
.st-group { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 32px; padding: 28px 0; border-top: 1px solid ${C.border}; }
.st-group:first-child { border-top: none; padding-top: 4px; }
.st-group-title { margin: 0 0 6px; font-size: 15px; font-weight: 700; color: ${C.ink}; }
.st-group-desc { margin: 0; font-size: 13px; line-height: 1.6; color: ${C.muted}; }
.st-cards { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.st-card { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 10px; overflow: hidden; }
.st-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid ${C.border}; }
.st-card-title { margin: 0; font-size: 14px; font-weight: 600; color: ${C.ink}; }
.st-card-desc { margin: 2px 0 0; font-size: 13px; line-height: 1.5; color: ${C.muted}; }
.st-card-body { padding: 20px; }
.st-badge { flex-shrink: 0; font-size: 12px; font-weight: 600; line-height: 1; padding: 6px 10px; border-radius: 99px; white-space: nowrap; }
.st-badge-success { background: ${C.successTint}; color: #0F7355; }
.st-badge-warning { background: ${C.warningTint}; color: #92400E; }
.st-badge-critical { background: ${C.dangerTint}; color: #B91C1C; }
.st-notice { border-left: 3px solid; border-radius: 0 6px 6px 0; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; line-height: 1.55; }
.st-notice-success { border-color: ${C.success}; background: ${C.successTint}; color: #0F7355; }
.st-notice-warning { border-color: ${C.warning}; background: ${C.warningTint}; color: #92400E; }
.st-notice-critical { border-color: #DC2626; background: ${C.dangerTint}; color: #B91C1C; }
.st-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
.st-label { display: block; padding: 0; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: ${C.text}; }
.st-help { margin: 12px 0 0; font-size: 12px; line-height: 1.6; color: ${C.muted}; }
.st-field .st-help { margin-top: 6px; }
.st-text { font-size: 13px; line-height: 1.6; color: ${C.text}; }
.st-strong { color: ${C.text}; font-weight: 600; }
.st-input { width: 100%; box-sizing: border-box; padding: 8px 11px; border: 1px solid #D4D1E3; border-radius: 7px; font-size: 13px; color: ${C.text}; background: ${C.surface}; font-family: inherit; outline: none; }
.st-input:focus { border-color: ${C.brand}; box-shadow: 0 0 0 3px ${C.brandTint}; }
.st-input:disabled { background: ${C.bg}; color: ${C.muted}; }
.st-steps { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8; color: ${C.text}; }
.st-divider { height: 1px; background: ${C.border}; margin: 20px 0; }
.st-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
.st-fieldset { border: none; padding: 0; margin: 0; min-width: 0; }
.st-choices { display: flex; flex-direction: column; gap: 8px; }
.st-choice { display: grid; grid-template-columns: auto 1fr; column-gap: 12px; row-gap: 2px; align-items: start; padding: 12px 14px; border: 1px solid ${C.border}; border-radius: 8px; cursor: pointer; }
.st-choice:has(input:checked) { border-color: ${C.brand}; background: #FAFAFE; }
.st-choice input, .st-check input, .st-day input { margin: 2px 0 0; accent-color: ${C.brand}; }
.st-choice-title { font-size: 13px; font-weight: 600; color: ${C.text}; }
.st-choice-desc { grid-column: 2; font-size: 12px; line-height: 1.55; color: ${C.muted}; }
.st-tag { margin-left: 8px; font-size: 11px; font-weight: 600; color: ${C.brand}; }
.st-check { display: grid; grid-template-columns: auto 1fr; column-gap: 12px; row-gap: 2px; align-items: start; cursor: pointer; }
.st-day { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border: 1px solid ${C.border}; border-radius: 7px; font-size: 13px; color: ${C.text}; cursor: pointer; }
.st-day:has(input:checked) { border-color: ${C.brand}; background: #FAFAFE; }
.st-day input { margin: 0; }
.st-btn { padding: 8px 18px; border-radius: 7px; font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; white-space: nowrap; }
.st-btn-primary { background: ${C.brand}; color: #FFFFFF; border: 1px solid ${C.brand}; }
.st-btn-primary:hover:not(:disabled) { background: ${C.brandHover}; }
.st-btn-secondary { background: ${C.surface}; color: ${C.text}; border: 1px solid #D4D1E3; }
.st-btn-secondary:hover:not(:disabled) { background: ${C.bg}; }
.st-btn:disabled { opacity: 0.6; cursor: not-allowed; }
@media (max-width: 800px) {
  .st-group { grid-template-columns: minmax(0, 1fr); gap: 14px; }
}
@media (max-width: 520px) {
  .st-grid2 { grid-template-columns: minmax(0, 1fr); }
  .st-card-head { flex-direction: column; }
}
`;

function Group({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="st-group">
      <div>
        <h2 className="st-group-title">{title}</h2>
        <p className="st-group-desc">{description}</p>
      </div>
      <div className="st-cards">{children}</div>
    </section>
  );
}

function Card({ title, description, badge, children }: {
  title: string;
  description?: string;
  badge?: { tone: Tone; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="st-card">
      <div className="st-card-head">
        <div>
          <h3 className="st-card-title">{title}</h3>
          {description && <p className="st-card-desc">{description}</p>}
        </div>
        {badge && <span className={`st-badge st-badge-${badge.tone}`}>{badge.label}</span>}
      </div>
      <div className="st-card-body">{children}</div>
    </div>
  );
}

function Field({ label, htmlFor, help, children, fullWidth }: {
  label: string;
  htmlFor: string;
  help?: string;
  children: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div className="st-field" style={{ gridColumn: fullWidth ? "1 / -1" : undefined }}>
      <label htmlFor={htmlFor} className="st-label">{label}</label>
      {children}
      {help && <p className="st-help">{help}</p>}
    </div>
  );
}

function Choice({ name, value, label, desc, defaultChecked, recommended }: {
  name: string;
  value: string;
  label: string;
  desc: string;
  defaultChecked: boolean;
  recommended?: boolean;
}) {
  const id = `${name}-${value}`;
  return (
    <label htmlFor={id} className="st-choice">
      <input id={id} type="radio" name={name} value={value} defaultChecked={defaultChecked} />
      <span className="st-choice-title">
        {label}
        {recommended && <span className="st-tag">Recomendado</span>}
      </span>
      <span className="st-choice-desc">{desc}</span>
    </label>
  );
}

function Notice({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div role={tone === "critical" ? "alert" : "status"} className={`st-notice st-notice-${tone}`}>{children}</div>;
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="st-actions">{children}</div>;
}

function Btn({ children, variant = "primary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
}) {
  return <button {...props} className={`st-btn st-btn-${variant}`}>{children}</button>;
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
