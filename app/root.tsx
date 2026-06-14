import { Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError } from "react-router";
import { FONT, DISPLAY_FONT, colors } from "./lib/theme";

export default function App() {
  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/fium-icono.svg" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500&display=swap" rel="stylesheet" />
        <Meta />
        <Links />
      </head>
      <body suppressHydrationWarning>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const title = isResponse ? `${error.status} ${error.statusText}` : "Algo salió mal";
  const detail = isResponse
    ? "No pudimos cargar esta página."
    : "Ocurrió un error inesperado. Vuelve a intentarlo en unos momentos.";

  return (
    <html lang="es">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title}</title>
        <Meta />
        <Links />
      </head>
      <body suppressHydrationWarning style={{ fontFamily: FONT, background: colors.bg, margin: 0 }}>
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: "48px", marginBottom: "8px" }}>⚠️</div>
          <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: "24px", fontWeight: 700, color: colors.ink, margin: "0 0 8px" }}>{title}</h1>
          <p style={{ fontSize: "15px", color: colors.muted, margin: 0, maxWidth: "420px", lineHeight: 1.6 }}>{detail}</p>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
