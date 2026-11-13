import { cache } from "react";
import { compose } from "../react/compose.ts";
import type { Host, Scope } from "../runtime.ts";

const request = cache((): { scope?: Scope } => ({}));

export const host: Host = {
  get: () => request().scope,
  set(scope) {
    const slot = request();
    // Outside a render `cache` does not memoize, so there is no request to keep the scope in.
    if (slot !== request()) return false;
    slot.scope = scope;
    return true;
  },
  compose,
};
