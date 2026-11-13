import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const base = join(import.meta.dir, ".tmp");

export function project(name: string, files: Record<string, string>): string {
  const root = join(base, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  write(root, files);
  return root;
}

export function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

export function catalog(root: string, locale: string): Record<string, string> {
  return JSON.parse(read(root, `locales/${locale}.json`));
}
