import { host } from "#host";
import { type Kind, type Node, parse, sourceLocale } from "./message.ts";
import type { Arguments, Message, Result } from "./params.ts";

export type Catalog = Readonly<Record<string, string>>;
export type Loader = () => Promise<{ default: Catalog }>;

type Values = Readonly<Record<string, unknown>>;
type Template = string | { nodes: Node[]; locale: string };

export interface Scope {
  locale: string;
  catalog: Catalog;
  templates: Map<string, Template>;
}

export interface Host {
  get(): Scope | undefined;
  set(scope: Scope): boolean;
  compose(parts: unknown[]): unknown;
}

const hooks = globalThis.process?.getBuiltinModule?.("node:async_hooks");
const storage = hooks && new hooks.AsyncLocalStorage<Scope>();
const loading = new WeakMap<Loader, Promise<Scope>>();
const formats = new Map<string, Intl.NumberFormat | Intl.PluralRules>();

let fallback = scopeOf(sourceLocale, {});

/**
 * Translates a message into the active locale. Without a translation, formats the message
 * itself. A message with tags returns what its tag functions return, combined.
 */
export function t<M extends Message | (string & {})>(
  message: M,
  ...params: Arguments<M>
): Result<M>;
export function t(message: string, params: Values = {}): unknown {
  const scope = current();
  let template = scope.templates.get(message);
  if (template === undefined) {
    template = compile(scope, message);
    scope.templates.set(message, template);
  }
  if (typeof template === "string") return template;
  return combine(render(template.nodes, params, template.locale, 0));
}

/** The active locale. */
export function getLocale(): string {
  return current().locale;
}

/**
 * Loads a catalog and makes its locale active. With `run`, the locale is active only for `run`
 * and what it awaits. The generated `locales/index.js` exports this as `setLocale`.
 */
export function activate(locale: string, load: Loader | undefined): Promise<void>;
export function activate<T>(
  locale: string,
  load: Loader | undefined,
  run: () => T,
): Promise<Awaited<T>>;
export async function activate(
  locale: string,
  load: Loader | undefined,
  run?: () => unknown,
): Promise<unknown> {
  if (!load) throw new RangeError(`dicto: there is no "${locale}" catalog`);
  let pending = loading.get(load);
  if (!pending) {
    pending = load().then((module) => scopeOf(locale, module.default));
    loading.set(load, pending);
    pending.catch(() => loading.delete(load));
  }
  const scope = await pending;
  if (run && storage) return storage.run(scope, run);
  if (!host.set(scope)) adopt(scope);
  return run?.();
}

export function current(): Scope {
  return storage?.getStore() ?? host.get() ?? fallback;
}

export function adopt(scope: Scope): void {
  fallback = scope;
}

export function scopeOf(locale: string, catalog: Catalog): Scope {
  return { locale, catalog, templates: new Map() };
}

function compile(scope: Scope, message: string): Template {
  const translation = Object.hasOwn(scope.catalog, message) ? scope.catalog[message] : undefined;
  for (const [text, locale] of [[translation, scope.locale], [message, sourceLocale]] as const) {
    if (!text) continue;
    try {
      const nodes = parse(text);
      return nodes.every((node) => typeof node === "string") ? nodes.join("") : { nodes, locale };
    } catch {}
  }
  return message;
}

function render(nodes: Node[], params: Values, locale: string, count: number): unknown[] {
  const parts: unknown[] = [];
  const push = (part: unknown): void => {
    const last = parts.length - 1;
    if (typeof part === "string" && typeof parts[last] === "string") parts[last] += part;
    else if (part !== "") parts.push(part);
  };
  for (const node of nodes) {
    if (typeof node === "string") {
      push(node);
    } else if (node.type === "argument") {
      const value = params[node.name];
      push(typeof value === "number" ? numberFormat(locale).format(value) : String(value));
    } else if (node.type === "pound") {
      push(numberFormat(locale).format(count));
    } else if (node.type === "choice") {
      const value = params[node.name];
      const next = node.kind === "select" ? count : Number(value);
      for (const part of render(option(node, value, locale), params, locale, next)) push(part);
    } else {
      const children = node.children && combine(render(node.children, params, locale, count));
      const tag = params[node.name];
      push(typeof tag === "function" ? tag(children ?? "") : (children ?? ""));
    }
  }
  return parts;
}

function option(
  { kind, options }: { kind: Kind; options: Map<string, Node[]> },
  value: unknown,
  locale: string,
): Node[] {
  const chosen =
    kind === "select"
      ? options.get(String(value))
      : (options.get(`=${value}`) ?? options.get(pluralRules(locale, kind).select(Number(value))));
  return chosen ?? options.get("other")!;
}

function combine(parts: unknown[]): unknown {
  if (parts.every((part) => typeof part === "string")) return parts.join("");
  return host.compose(parts);
}

function numberFormat(locale: string): Intl.NumberFormat {
  return memo(locale, () => new Intl.NumberFormat(locale));
}

function pluralRules(locale: string, kind: Kind): Intl.PluralRules {
  const type = kind === "selectordinal" ? "ordinal" : "cardinal";
  return memo(`${locale} ${type}`, () => new Intl.PluralRules(locale, { type }));
}

function memo<T extends Intl.NumberFormat | Intl.PluralRules>(key: string, create: () => T): T {
  let format = formats.get(key) as T | undefined;
  if (!format) {
    format = create();
    formats.set(key, format);
  }
  return format;
}
