import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startTransition(() => {
  hydrateRoot(document, <HydratedRouter />, {
    onRecoverableError(error) {
      // Shopify web components (App Bridge) modify the DOM after mount,
      // causing expected hydration mismatches. We handle them silently.
      if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof (error as Error).message === "string" &&
        (error as Error).message.includes("Hydration")
      ) {
        return;
      }
      console.error(error);
    },
  });
});
