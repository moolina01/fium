import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { MessageCircle } from "lucide-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

// Soporte por WhatsApp — +56 9 4937 8795. Formato wa.me: código de país + número, sin "+".
const SUPPORT_WHATSAPP = "56949378795";
const SUPPORT_MESSAGE = "Hola, necesito ayuda con Fium";

function SupportButton() {
  const href = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="Soporte por WhatsApp"
      style={{
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: 999,
        width: "52px",
        height: "52px",
        borderRadius: "50%",
        background: "#25D366",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 4px 14px rgba(0,0,0,0.28)",
        textDecoration: "none",
      }}
    >
      <MessageCircle size={26} color="#fff" strokeWidth={2} />
    </a>
  );
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const location = useLocation();
  const isOnboarding = location.pathname === "/app/onboarding";

  return (
    <AppProvider embedded apiKey={apiKey}>
      {!isOnboarding && (
        <s-app-nav>
          <s-link href="/app">Envíos</s-link>
          <s-link href="/app/settings">Configuración</s-link>
        </s-app-nav>
      )}
      <Outlet />
      <SupportButton />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
