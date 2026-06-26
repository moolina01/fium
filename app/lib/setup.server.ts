import { apiVersion } from "../shopify.server";
import db from "../db.server";
import { logError } from "./logger.server";

/**
 * Consulta a Shopify si el carrier service "Fium" está registrado en la tienda.
 * Es el paso que hace que Fium aparezca como opción de envío en el checkout.
 * Aunque `afterAuth` lo registra al instalar, puede fallar (requiere el scope
 * write_shipping y un plan Shopify compatible con carrier-calculated shipping),
 * así que verificamos el estado real en vez de asumirlo.
 */
export async function isCarrierRegistered(shop: string, accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://${shop}/admin/api/${apiVersion}/carrier_services.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!res.ok) return false;
    const { carrier_services } = (await res.json()) as { carrier_services: { name: string }[] };
    return carrier_services.some((cs) => cs.name === "Fium");
  } catch (e) {
    logError("setup/is-carrier-registered", e, { shop });
    return false;
  }
}

export type SetupStep = {
  key: "address" | "carrier" | "phone";
  label: string;
  description: string;
  done: boolean;
};

export type SetupChecklist = {
  steps: SetupStep[];
  complete: boolean;
  // Última vez que Shopify pidió tarifas a Fium en el checkout, ISO string (null = nunca).
  // Confirma que el carrier no solo está registrado, sino realmente activo en el checkout.
  carrierLiveAt: string | null;
  // El carrier service existe en Shopify (se registra solo al instalar). Sirve para
  // distinguir "registrado pero falta agregarlo a la zona de envío" de "activo en vivo".
  carrierRegistered: boolean;
};

/**
 * Estado de configuración de la tienda como checklist de 3 pasos.
 * Es la fuente única de verdad para el progreso de setup: la usan tanto el
 * onboarding como el banner del dashboard.
 */
export async function getSetupChecklist(shop: string, accessToken: string): Promise<SetupChecklist> {
  const [config, carrierRegistered] = await Promise.all([
    db.storeConfig.findUnique({ where: { shop } }),
    isCarrierRegistered(shop, accessToken),
  ]);

  const steps: SetupStep[] = [
    {
      key: "address",
      label: "Dirección de despacho",
      description: "Dónde Uber Direct recoge tus pedidos.",
      done: !!config,
    },
    {
      key: "carrier",
      // El carrier service se registra solo al instalar la app (afterAuth), así que
      // "registrado" NO significa que el merchant lo configuró. El paso se marca hecho
      // cuando el merchant confirma que lo agregó a su zona de envío ("Ya lo activé")
      // O cuando Shopify ya pidió tarifas en un checkout real (señal en vivo).
      label: "Activa Fium en tu checkout",
      description: "Agrégalo a tu zona de envío en Shopify y confirma con \"Ya lo activé\".",
      done: !!config?.carrierActivatedAck || !!config?.lastRateRequestAt,
    },
    {
      key: "phone",
      label: "Exige teléfono en el checkout",
      description: "Uber necesita el teléfono del cliente para cada envío.",
      done: !!config?.phoneRequiredAck,
    },
  ];

  return {
    steps,
    complete: steps.every((s) => s.done),
    carrierLiveAt: config?.lastRateRequestAt?.toISOString() ?? null,
    carrierRegistered,
  };
}
