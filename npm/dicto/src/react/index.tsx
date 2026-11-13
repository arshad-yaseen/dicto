import type { ReactNode } from "react";
import { current } from "../runtime.ts";
import { Provider } from "./provider.tsx";

declare module "../index.js" {
  interface Register {
    node: ReactNode;
  }
}

/**
 * Passes the active locale to Client Components, and lets messages with tags render React
 * elements. Render it once around your app, after setting the locale.
 */
export function Locale({ children }: { children: ReactNode }): ReactNode {
  const { locale, catalog } = current();
  return (
    <Provider locale={locale} catalog={catalog}>
      {children}
    </Provider>
  );
}
