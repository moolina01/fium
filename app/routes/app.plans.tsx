import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { colors as F, FONT, DISPLAY_FONT } from "../lib/theme";

const PLANS = [
  {
    key: "starter",
    name: "Starter",
    price: null,
    priceLabel: "Gratis",
    description: "Para probar Fium sin compromiso.",
    deliveries: "15 envíos / mes",
    features: [
      "Cotización en tiempo real en el checkout",
      "Dashboard de seguimiento",
      "Historial de envíos",
    ],
    cta: "Empezar gratis",
    highlighted: false,
  },
  {
    key: "growth",
    name: "Growth",
    price: "9.00",
    priceLabel: "$9 USD / mes",
    description: "Para tiendas con envíos frecuentes.",
    deliveries: "100 envíos / mes",
    features: [
      "Todo lo de Starter",
      "Dispatch automático al pagar",
      "Notificaciones de estado del envío",
      "Saldo mínimo de recarga reducido",
    ],
    cta: "Elegir Growth",
    highlighted: true,
  },
  {
    key: "pro",
    name: "Pro",
    price: "29.00",
    priceLabel: "$29 USD / mes",
    description: "Para tiendas de alto volumen.",
    deliveries: "Envíos ilimitados",
    features: [
      "Todo lo de Growth",
      "Soporte prioritario",
      "Wallet con menor recarga mínima",
      "Reportes mensuales",
    ],
    cta: "Elegir Pro",
    highlighted: false,
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const config = await db.storeConfig.findUnique({ where: { shop: session.shop } });
  if (!config) throw redirect("/app/onboarding");
  return { currentPlan: config.plan, planStatus: config.planStatus };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = formData.get("plan") as string;

  if (plan === "starter") {
    const config = await db.storeConfig.findUnique({ where: { shop: session.shop } });

    // Si tiene suscripción paga activa, cancelarla en Shopify antes de bajar a Starter
    if (config?.subscriptionId) {
      await admin.graphql(`
        #graphql
        mutation CancelSubscription($id: ID!) {
          appSubscriptionCancel(id: $id) {
            appSubscription { id status }
            userErrors { field message }
          }
        }
      `, { variables: { id: config.subscriptionId } });
    }

    await db.storeConfig.update({
      where: { shop: session.shop },
      data: { plan: "starter", planStatus: "active", subscriptionId: null },
    });
    throw redirect("/app");
  }

  const planConfig = PLANS.find((p) => p.key === plan);
  if (!planConfig?.price) return { error: "Plan inválido." };

  const appUrl = process.env.SHOPIFY_APP_URL!;

  const res = await admin.graphql(`
    #graphql
    mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!, $test: Boolean) {
      appSubscriptionCreate(name: $name, lineItems: $lineItems, returnUrl: $returnUrl, test: $test) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }
  `, {
    variables: {
      name: `Fium ${planConfig.name}`,
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount: planConfig.price, currencyCode: "USD" },
            interval: "EVERY_30_DAYS",
          },
        },
      }],
      returnUrl: `${appUrl}/app/plans/confirm?plan=${plan}`,
      test: process.env.NODE_ENV !== "production",
    },
  });

  const json = await res.json();
  const { confirmationUrl, appSubscription, userErrors } = json.data?.appSubscriptionCreate ?? {};

  if (userErrors?.length) return { error: userErrors[0].message };
  if (!confirmationUrl) return { error: "Shopify no devolvió URL de pago. Intenta de nuevo." };

  await db.storeConfig.update({
    where: { shop: session.shop },
    data: { plan, planStatus: "pending", subscriptionId: appSubscription?.id ?? null },
  });

  // El confirmationUrl es la página de cobro de Shopify — debe salir del iframe.
  throw redirect(confirmationUrl, { target: "_top" });
};

export default function Plans() {
  const { currentPlan, planStatus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const font = { fontFamily: FONT };

  return (
    <div style={{ minHeight: "100vh", background: F.bg, ...font, padding: "48px 24px" }}>
      <div style={{ maxWidth: "860px", margin: "0 auto" }}>

        {actionData?.error && (
          <div style={{
            background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: "10px",
            padding: "12px 16px", marginBottom: "24px", color: "#DC2626",
            fontSize: "14px", textAlign: "center",
          }}>
            ⚠️ {actionData.error}
          </div>
        )}

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div style={{
            display: "inline-block", background: F.brandTint, color: F.brand,
            fontSize: "12px", fontWeight: "700", padding: "4px 14px",
            borderRadius: "99px", marginBottom: "14px", letterSpacing: "0.5px",
          }}>
            PLANES
          </div>
          <h1 style={{
            fontFamily: DISPLAY_FONT, fontSize: "30px",
            fontWeight: "700", color: F.ink, margin: "0 0 10px",
          }}>
            Elige tu plan
          </h1>
          <p style={{ fontSize: "15px", color: F.muted, margin: 0 }}>
            Empieza gratis y escala cuando lo necesites. Sin contratos.
          </p>
        </div>

        {/* Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
          {PLANS.map((plan) => (
            <div key={plan.key} style={{
              background: F.surface,
              borderRadius: "14px",
              border: plan.highlighted ? `2px solid ${F.brand}` : `1px solid ${F.border}`,
              padding: "28px 24px",
              position: "relative",
              boxShadow: plan.highlighted ? "0 4px 20px rgba(75,43,224,0.15)" : "none",
            }}>
              {plan.highlighted && (
                <div style={{
                  position: "absolute", top: "-12px", left: "50%",
                  transform: "translateX(-50%)",
                  background: F.accent, color: F.ink,
                  fontSize: "11px", fontWeight: "800",
                  padding: "3px 14px", borderRadius: "99px",
                  letterSpacing: "0.5px",
                }}>
                  MÁS POPULAR
                </div>
              )}

              <div style={{ marginBottom: "20px" }}>
                <div style={{ fontSize: "13px", fontWeight: "700", color: F.brand, marginBottom: "6px" }}>
                  {plan.name}
                </div>
                <div style={{
                  fontFamily: DISPLAY_FONT,
                  fontSize: "28px", fontWeight: "700", color: F.ink, marginBottom: "4px",
                }}>
                  {plan.priceLabel}
                </div>
                <div style={{ fontSize: "12px", color: F.muted }}>{plan.description}</div>
              </div>

              <div style={{
                background: F.brandTint, borderRadius: "8px",
                padding: "8px 12px", marginBottom: "20px",
                fontSize: "13px", fontWeight: "700", color: F.brand,
              }}>
                {plan.deliveries}
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "24px" }}>
                {plan.features.map((f) => (
                  <div key={f} style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                    <span style={{ color: F.brand, fontWeight: "700", flexShrink: 0 }}>✓</span>
                    <span style={{ fontSize: "13px", color: F.text, lineHeight: "1.4" }}>{f}</span>
                  </div>
                ))}
              </div>

              <Form method="post">
                <input type="hidden" name="plan" value={plan.key} />
                <button
                  type="submit"
                  disabled={submitting || currentPlan === plan.key}
                  style={{
                    width: "100%", padding: "11px",
                    background: currentPlan === plan.key
                      ? "#e5e7eb"
                      : plan.highlighted ? F.brand : "transparent",
                    color: currentPlan === plan.key
                      ? F.muted
                      : plan.highlighted ? "#fff" : F.brand,
                    border: plan.highlighted ? "none" : `2px solid ${F.brand}`,
                    borderRadius: "8px", fontSize: "14px", fontWeight: "700",
                    cursor: (submitting || currentPlan === plan.key) ? "not-allowed" : "pointer",
                    ...font,
                  }}
                >
                  {currentPlan === plan.key && planStatus === "active" ? "Plan actual ✓" : plan.cta}
                </button>
              </Form>
            </div>
          ))}
        </div>

        <p style={{ textAlign: "center", fontSize: "12px", color: F.muted, marginTop: "24px" }}>
          Los envíos se cobran aparte desde tu wallet Fium. El plan es solo por la plataforma.
        </p>
      </div>
    </div>
  );
}
