import { type FSWatcher, readdirSync, watch } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { folder, sync } from "./catalogs.ts";
import { reasons } from "./scan.ts";

const source = /\.[cm]?[jt]sx?$/;
const settleMs = 10;

export interface Log {
  warn(message: string): void;
  error(message: string): void;
}

export function follow(root: string, log: Log): (path: string) => void {
  const catalogs = join(root, folder);
  const warned = new Set<string>();
  const timer = setTimeout(() => {
    try {
      for (const { path, line, column, kind } of sync(root, { prune: false }).problems) {
        const warning = `dicto: ${path}:${line}:${column} ${reasons[kind]}`;
        if (kind === "syntax" || warned.has(warning)) continue;
        warned.add(warning);
        log.warn(warning);
      }
    } catch (error) {
      log.error(String(error));
    }
  }, settleMs);
  return (path) => {
    const inCatalogs = relative(catalogs, path);
    if (source.test(path) && (inCatalogs.startsWith("..") || isAbsolute(inCatalogs))) {
      timer.refresh();
    }
  };
}

export function watchProject(root: string, onChange: (path: string) => void): void {
  const watchers = new Map<string, FSWatcher>();
  const refresh = (): void => {
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith(".") && name !== "node_modules");
    for (const [name, watcher] of watchers) {
      if (names.includes(name)) continue;
      watcher.close();
      watchers.delete(name);
    }
    for (const name of names) {
      if (watchers.has(name)) continue;
      const directory = join(root, name);
      const watcher = watch(directory, { recursive: true }, (_event, file) => {
        if (file) onChange(join(directory, file));
      });
      watchers.set(name, watcher);
    }
  };
  watch(root, (_event, file) => {
    if (file) onChange(join(root, file));
    refresh();
  });
  refresh();
}
