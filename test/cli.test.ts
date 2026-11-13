import { expect, test } from "bun:test";
import { join } from "node:path";
import { catalog, project, read } from "./fixture.ts";

const cli = join(import.meta.dir, "../npm/dicto/dist/cli/index.js");

function run(root: string, ...args: string[]): { code: number; output: string } {
  const { exitCode, stdout, stderr } = Bun.spawnSync(["node", cli, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const output = `${stdout}${stderr}`.replace(/\d+ ms/, "0 ms");
  return { code: exitCode, output };
}

const app = `import { t } from "dicto";
export const title = t("Welcome");
export const greeting = (name: string) => t("Hello, {name}!", { name });
`;

test("a project without languages says how to add one", () => {
  const root = project("cli-bare", { "src/app.ts": app });
  expect(run(root)).toEqual({
    code: 0,
    output: `
  dicto  2 messages  0 ms

  No languages yet. Add one with dicto add

`,
  });
});

test("add creates a catalog for each named language", () => {
  const root = project("cli-add", { "src/app.ts": app });
  expect(run(root, "add", "french", "ja")).toEqual({
    code: 0,
    output: `
  Added  fr  French
  Added  ja  Japanese

  dicto  2 messages  0 ms

  fr  2 untranslated
  ja  2 untranslated

`,
  });
  expect(catalog(root, "ja")).toEqual({ "Hello, {name}!": "", Welcome: "" });
  expect(read(root, "locales/index.js")).toContain('"ja": () => import("./ja.json"');

  expect(run(root, "add", "fr").output).toContain("  Has  fr  French\n");
});

test("add refuses a name that is no language or more than one", () => {
  const root = project("cli-add-unknown", { "src/app.ts": app });
  expect(run(root, "add", "zzzz")).toEqual({ code: 1, output: '\n  "zzzz" names no language\n\n' });
  const { code, output } = run(root, "add", "chin");
  expect(code).toBe(1);
  expect(output).toStartWith('\n  "chin" names more than one language\n  zh      Chinese\n');
  expect(run(root, "add", "english")).toEqual({
    code: 1,
    output: "\n  en is the language the source is written in\n\n",
  });
  expect(run(root, "add")).toEqual({
    code: 2,
    output: "\n  Name a language, as in dicto add french\n\n",
  });
  expect(() => read(root, "locales/index.js")).toThrow();
});

test("the check passes once everything is translated", () => {
  const root = project("cli-check", {
    "src/app.ts": app,
    "locales/fr.json": JSON.stringify({ Welcome: "Bienvenue", Old: "Vieux" }),
  });
  expect(run(root)).toEqual({
    code: 1,
    output: `
  dicto  2 messages  0 ms

  fr  1 untranslated

`,
  });
  expect(catalog(root, "fr")).toEqual({ "Hello, {name}!": "", Welcome: "Bienvenue" });

  Bun.write(
    join(root, "locales/fr.json"),
    JSON.stringify({ "Hello, {name}!": "Bonjour, {name} !", Welcome: "Bienvenue" }),
  );
  expect(run(root)).toEqual({
    code: 0,
    output: `
  dicto  2 messages  0 ms

  fr  translated

`,
  });
});

test("the check lists what is invalid and where the source is wrong", () => {
  const root = project("cli-problems", {
    "src/app.ts": `${app}const key = "Dynamic";\nt(key);\n`,
    "src/lib.ts": 'export * from "dicto";\n',
    "locales/fr.json": JSON.stringify({ "Hello, {name}!": "Bonjour !", Welcome: "Bienvenue" }),
    "locales/zz-invalid-.json": "{}",
  });
  expect(run(root)).toEqual({
    code: 1,
    output: `
  dicto  2 messages  0 ms

  fr           1 invalid
  zz-invalid-  1 invalid

  fr           "Hello, {name}!"  is missing {name}
  zz-invalid-  is not a locale
  src/app.ts:5:3  t must be called with a string literal
  src/lib.ts:1:1  t must be imported by name from "dicto"

`,
  });
});

test("a file that does not parse leaves the catalogs alone", () => {
  const root = project("cli-syntax", {
    "src/app.ts": `${app}t("Unclosed"`,
    "locales/fr.json": JSON.stringify({ Old: "Vieux" }),
  });
  expect(run(root)).toEqual({
    code: 1,
    output: `
  dicto  0 messages  0 ms

  src/app.ts:4:13  does not parse, so the catalogs stay as they are

`,
  });
  expect(catalog(root, "fr")).toEqual({ Old: "Vieux" });
});

test("anything else prints the usage", () => {
  const root = project("cli-usage", {});
  const usage = `
  dicto                    Sync the catalogs with the source and check them
  dicto add [language...]  Add a language, searching when none is named

`;
  expect(run(root, "--help")).toEqual({ code: 0, output: usage });
  expect(run(root, "remove")).toEqual({ code: 2, output: usage });
});
