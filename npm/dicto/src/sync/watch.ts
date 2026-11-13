import { type FSWatcher, readdirSync, watch } from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { folder, update } from "./catalogs.ts";
import { reasons, rescan, scan } from "./scan.ts";

const source = /\.[cm]?[jt]sx?$/;
const settleMs = 10;
const rescanMax = 256;

export interface Log {
  warn(message: string): void;
  error(message: string): void;
}

export function follow(root: string, log: Log): (path: string) => void {
  const files = new Map<string, string[]>();
  const counts = new Map<string, number>();
  const warned = new Set<string>();
  const pending = new Set<string>();
  let everything = true;

  const replace = (path: string, next: string[]): boolean => {
    let changed = false;
    for (const message of new Set(files.get(path))) {
      const count = counts.get(message)! - 1;
      if (count === 0) counts.delete(message);
      else counts.set(message, count);
      changed ||= count === 0;
    }
    for (const message of new Set(next)) {
      const count = counts.get(message) ?? 0;
      counts.set(message, count + 1);
      changed ||= count === 0;
    }
    if (next.length > 0) files.set(path, next);
    else files.delete(path);
    return changed;
  };

  const flush = (): void => {
    const full = everything;
    const paths = [...pending];
    everything = false;
    pending.clear();
    try {
      const result = full ? scan(root) : rescan(root, paths);
      const broken = new Set<string>();
      for (const { path, line, column, kind } of result.problems) {
        if (kind === "syntax") {
          broken.add(path);
          continue;
        }
        const warning = `dicto: ${path}:${line}:${column} ${reasons[kind]}`;
        if (!warned.has(warning)) log.warn(warning);
        warned.add(warning);
      }
      const fresh = new Map(result.files.map((file) => [file.path, file.messages]));
      let changed = full && files.size === 0;
      for (const path of full ? new Set([...files.keys(), ...fresh.keys()]) : paths) {
        if (!broken.has(path)) changed = replace(path, fresh.get(path) ?? []) || changed;
      }
      if (changed) update(root, [...counts.keys()].sort(), false);
    } catch (error) {
      log.error(String(error));
    }
  };

  const timer = setTimeout(flush, settleMs);
  return (path) => {
    const local = relative(root, path).split(sep).join("/");
    if (local.startsWith("..") || isAbsolute(local) || local.startsWith(`${folder}/`)) return;
    if (source.test(local)) pending.add(local);
    else if (basename(local) === ".gitignore" || extname(local) === "") everything = true;
    else return;
    if (pending.size > rescanMax) everything = true;
    timer.refresh();
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
