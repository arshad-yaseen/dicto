export type { Message } from "./params.ts";
export { activate, type Catalog, getLocale, type Loader, t } from "./runtime.ts";

/** Filled in by the generated `locales/index.d.ts` with every message in the project. */
export interface Register {}
