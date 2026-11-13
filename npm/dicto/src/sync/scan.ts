import { createRequire } from "node:module";

export interface Problem {
  path: string;
  line: number;
  column: number;
  kind: "syntax" | "call" | "import";
}

export interface Scan {
  files: { path: string; messages: string[] }[];
  problems: Problem[];
}

interface Native {
  scan(root: string): Scan;
  rescan(root: string, paths: string[]): Scan;
}

export const reasons: Record<Problem["kind"], string> = {
  syntax: "does not parse, so the catalogs stay as they are",
  call: "t must be called with a string literal",
  import: 't must be imported by name from "dicto"',
};

const native = load();

export const scan: Native["scan"] = native.scan;
export const rescan: Native["rescan"] = native.rescan;

function load(): Native {
  const require = createRequire(import.meta.url);
  const { platform, arch } = process;
  const targets = platform === "linux" ? [`${arch}-gnu`, `${arch}-musl`] : [arch];
  let cause: unknown;
  for (const target of targets) {
    try {
      return require(`@dicto/${platform}-${target}`);
    } catch (error) {
      cause = error;
    }
  }
  throw new Error(`dicto: no native scanner for ${platform}-${arch}`, { cause });
}
