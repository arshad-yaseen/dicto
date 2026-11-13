import { emitKeypressEvents, type Key } from "node:readline";
import { styleText } from "node:util";

export interface Language {
  code: string;
  name: string;
  native: string;
}

const letters = "abcdefghijklmnopqrstuvwxyz";
const dialects = ["en-GB", "es-419", "fr-CA", "pt-BR", "pt-PT", "zh-Hans", "zh-Hant"];
const english = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
const exactName = 1;
const unranked = 5;
const rowsMax = 7;

export function languageOf(tag: string): Language | undefined {
  let code: string | undefined;
  try {
    [code] = Intl.getCanonicalLocales(tag);
  } catch {
    return undefined;
  }
  const name = code && english.of(code);
  if (!code || !name) return undefined;
  const own = new Intl.DisplayNames([code], { type: "language", fallback: "none" });
  return { code, name, native: own.of(code) ?? name };
}

export function languages(): Language[] {
  const codes = [...letters].flatMap((first) => [...letters].map((second) => first + second));
  return [...codes, ...dialects]
    .flatMap((code) => {
      const language = languageOf(code);
      return language?.code === code ? [language] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function search(all: Language[], query: string): Language[] {
  const needle = fold(query);
  if (!needle) return [];
  const found = all
    .map((language) => ({ language, rank: rankOf(language, needle) }))
    .filter(({ rank }) => rank < unranked)
    .sort((a, b) => a.rank - b.rank)
    .map(({ language }) => language);
  const tagged = languageOf(query.trim());
  return tagged && !found.some(({ code }) => code === tagged.code) ? [tagged, ...found] : found;
}

export function named(all: Language[], query: string): Language | undefined {
  const needle = fold(query);
  const found = search(all, query);
  const exact = found.find((language) => rankOf(language, needle) <= exactName);
  return exact ?? (found.length === 1 ? found[0] : undefined);
}

export function pick(all: Language[]): Promise<Language | undefined> {
  const { stdin, stdout } = process;
  let query = "";
  let selected = 0;
  let results: Language[] = [];

  const row = ({ code, name, native }: Language, index: number): string => {
    const own = native === name ? "" : styleText("dim", `  ${native}`);
    const text = `${code.padEnd(8)}${name}${own}`;
    return index === selected ? `${styleText("cyan", "  › ")}${text}` : `    ${text}`;
  };
  const draw = (): void => {
    const empty = query ? "  No language matches" : "  Type a name or a code";
    const lines = results.length > 0 ? results.map(row) : [styleText("dim", empty)];
    const keys = styleText("dim", "  ↑↓ choose   enter add   esc cancel");
    const label = `  ${styleText("bold", "Language")}  ${query}`;
    stdout.write(`\r\x1b[J${label}\x1b7${["", ...lines, "", keys].join("\n")}\x1b8`);
  };

  return new Promise((resolve) => {
    const onKey = (text: string | undefined, key: Key): void => {
      if (key.name === "return") {
        if (results[selected]) finish(results[selected]);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(undefined);
      } else if (key.name === "up" || key.name === "down") {
        const next = selected + (key.name === "up" ? -1 : 1);
        selected = Math.max(0, Math.min(next, results.length - 1));
        draw();
      } else if (key.name === "backspace" || isPrintable(text, key)) {
        query = key.name === "backspace" ? [...query].slice(0, -1).join("") : query + text;
        results = search(all, query).slice(0, rowsMax);
        selected = 0;
        draw();
      }
    };
    const finish = (language: Language | undefined): void => {
      stdin.off("keypress", onKey).setRawMode(false).pause();
      stdout.write("\r\x1b[J");
      resolve(language);
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true).resume().on("keypress", onKey);
    stdout.write(`${"\n".repeat(rowsMax + 3)}\x1b[${rowsMax + 3}A`);
    draw();
  });
}

function rankOf({ code, name, native }: Language, needle: string): number {
  const names = [fold(name), fold(native)];
  if (fold(code) === needle) return 0;
  if (names.includes(needle)) return exactName;
  if (names.some((candidate) => candidate.startsWith(needle))) return 2;
  if (fold(code).startsWith(needle)) return 3;
  if (names.some((candidate) => candidate.includes(needle))) return 4;
  return unranked;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function isPrintable(text: string | undefined, key: Key): text is string {
  return text !== undefined && !key.ctrl && !key.meta && !/\p{Cc}/u.test(text);
}
