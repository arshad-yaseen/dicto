import type { Host } from "../runtime.ts";

export const host: Host = {
  get: () => undefined,
  set: () => false,
  compose: (parts) => parts,
};
