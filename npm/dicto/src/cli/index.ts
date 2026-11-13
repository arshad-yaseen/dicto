#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { styleText } from "node:util";
import { sourceLocale } from "../message.ts";
import { folder, sync, verify } from "../sync/catalogs.ts";
import { reasons } from "../sync/scan.ts";
import { type Language, languages, named, pick, search } from "./languages.ts";

const bold = (text: string): string => styleText("bold", text);
const dim = (text: string): string => styleText("dim", text);
const red = (text: string): string => styleText("red", text);

const root = process.cwd();
const usage = `
  ${bold("dicto")}                    Sync the catalogs with the source and check them
  ${bold("dicto add")} ${dim("[language...]")}  Add a language, searching when none is named
`;

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case undefined:
    process.exitCode = report(true) ? 0 : 1;
    break;
  case "add":
    process.exitCode = await add(args);
    break;
  default:
    console.log(usage);
    process.exitCode = ["help", "--help", "-h"].includes(command) ? 0 : 2;
}

function report(prune: boolean): boolean {
  const start = performance.now();
  const result = sync(root, { prune });
  const verdicts = verify(result);
  const elapsed = Math.round(performance.now() - start);
  const width = Math.max(0, ...verdicts.map(({ locale }) => locale.length));

  const count = result.messages.length;
  const summary = `${count} message${count === 1 ? "" : "s"}  ${elapsed} ms`;
  const header = [`  ${bold("dicto")}  ${dim(summary)}`];
  const statuses = verdicts.map(({ locale, untranslated, invalid }) => {
    const status = [
      untranslated > 0 && styleText("yellow", `${untranslated} untranslated`),
      invalid.length > 0 && red(`${invalid.length} invalid`),
    ].filter(Boolean);
    const text = status.join(dim(", ")) || styleText("green", "translated");
    return `  ${locale.padEnd(width)}  ${text}`;
  });
  if (result.catalogs.length === 0 && result.complete) {
    statuses.push(`  No languages yet. Add one with ${bold("dicto add")}`);
  }
  const details = [
    ...verdicts.flatMap(({ locale, invalid }) =>
      invalid.map(({ message, reason }) => {
        const subject = message === undefined ? "" : `  ${JSON.stringify(message)}`;
        return `  ${locale.padEnd(width)}${subject}  ${red(reason)}`;
      }),
    ),
    ...result.problems.map(({ path, line, column, kind }) => {
      return `  ${styleText("cyan", `${path}:${line}:${column}`)}  ${red(reasons[kind])}`;
    }),
  ];
  const sections = [header, statuses, details].filter((section) => section.length > 0);
  console.log(`\n${sections.map((section) => section.join("\n")).join("\n\n")}\n`);

  const done = verdicts.every(({ untranslated, invalid }) => untranslated + invalid.length === 0);
  return done && result.problems.length === 0;
}

async function add(queries: string[]): Promise<number> {
  const all = languages();
  const chosen: Language[] = [];
  if (queries.length === 0) {
    if (!process.stdin.isTTY) {
      console.error(`\n  Name a language, as in ${bold("dicto add french")}\n`);
      return 2;
    }
    const language = await pick(all);
    if (!language) return 130;
    chosen.push(language);
  }
  for (const query of queries) {
    const language = named(all, query);
    if (!language) {
      const close = search(all, query).slice(0, 5);
      const verdict = close.length > 0 ? "names more than one language" : "names no language";
      const lines = close.map(({ code, name }) => `  ${code.padEnd(8)}${name}`);
      console.error(["", `  ${JSON.stringify(query)} ${red(verdict)}`, ...lines, ""].join("\n"));
      return 1;
    }
    chosen.push(language);
  }
  if (chosen.some(({ code }) => code === sourceLocale)) {
    console.error(`\n  ${sourceLocale} ${red("is the language the source is written in")}\n`);
    return 1;
  }

  const directory = join(root, folder);
  mkdirSync(directory, { recursive: true });
  console.log();
  for (const { code, name } of chosen) {
    const path = join(directory, `${code}.json`);
    const exists = existsSync(path);
    if (!exists) writeFileSync(path, "{}\n");
    console.log(`  ${exists ? dim("Has") : styleText("green", "Added")}  ${code}  ${dim(name)}`);
  }
  report(false);
  return 0;
}
