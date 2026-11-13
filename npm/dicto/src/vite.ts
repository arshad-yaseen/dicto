import type { Plugin } from "vite";
import { follow } from "./sync/watch.ts";

/** Keeps the catalogs in step with the source while the dev server runs. */
export default function dicto(): Plugin {
  return {
    name: "dicto",
    configureServer({ config, watcher }) {
      const changed = follow(config.root, {
        warn: (message) => config.logger.warn(message, { timestamp: true }),
        error: (message) => config.logger.error(message, { timestamp: true }),
      });
      watcher.on("all", (_event, path) => changed(path));
    },
  };
}
