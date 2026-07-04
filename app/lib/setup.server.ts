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
  key: "address" | "uber" | "shopifyActivation";
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
  // Sub-estado crudo del paso "shopifyActivation" — el paso combina 2 confirmaciones
  // (zona de envío + teléfono obligatorio) bajo un solo botón, pero los cards que
  // renderizan ese paso necesitan cada sub-estado por separado para pintar 2 líneas.
  carrierActivatedAck: boolean;
  phoneRequiredAck: boolean;
  // Credenciales de Uber Direct guardadas (no valida contra Uber en cada carga).
  uberConnected: boolean;
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

  const carrierActivatedAck = !!config?.carrierActivatedAck;
  const phoneRequiredAck = !!config?.phoneRequiredAck;
  const uberConnected = !!(config?.uberClientId && config?.uberClientSecret && config?.uberCustomerId);
  const carrierDone = carrierActivatedAck || !!config?.lastRateRequestAt;

  const steps: SetupStep[] = [
    {
      key: "address",
      label: "Dirección de despacho",
      description: "Dónde Uber Direct recoge tus pedidos.",
      done: !!config,
    },
    {
      key: "uber",
      label: "Conecta tu cuenta de Uber Direct",
      description: "Tus credenciales de Uber Direct, para cotizar y despachar envíos.",
      done: uberConnected,
    },
    {
      key: "shopifyActivation",
      // Combina 2 confirmaciones (zona de envío + teléfono obligatorio) en un solo
      // paso con un solo botón — ver UberConnectCard/ShopifyActivationCard.
      label: "Activa Fium en tu checkout",
      description: "Agrégalo a tu zona de envío y exige el teléfono del cliente.",
      done: carrierDone && phoneRequiredAck,
    },
  ];

  return {
    steps,
    complete: steps.every((s) => s.done),
    carrierLiveAt: config?.lastRateRequestAt?.toISOString() ?? null,
    carrierRegistered,
    carrierActivatedAck,
    phoneRequiredAck,
    uberConnected,
  };
}
