import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import { follow, watchProject } from "./sync/watch.ts";

type Config =
  | NextConfig
  | ((phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>);

let watching = false;

/** Wraps a Next.js config so that `next dev` keeps the catalogs in step with the source. */
export default function dicto(config: Config = {}): Config {
  return (phase, context) => {
    if (phase === PHASE_DEVELOPMENT_SERVER && !watching) {
      watching = true;
      watchProject(process.cwd(), follow(process.cwd(), console));
    }
    return typeof config === "function" ? config(phase, context) : config;
  };
}
