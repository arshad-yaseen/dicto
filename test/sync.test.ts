import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getLocale, t } from "dicto";
import { sync, verify } from "../npm/dicto/src/sync/catalogs.ts";
import { catalog, project, read, write } from "./fixture.ts";

const items = "{count, plural, one {# item} other {# items}}";
const app = `import { t } from "dicto";
export const greeting = (name: string) => t("Hello, {name}!", { name });
export const cart = (count: number) => t("${items}", { count });
export const title = t("Welcome");
`;

describe("sync", () => {
  test("every catalog gains the messages it lacks, sorted", () => {
    const root = project("sync-add", {
      "src/app.ts": app,
      "locales/fr.json": JSON.stringify({ Welcome: "Bienvenue" }),
      "locales/ja.json": "",
    });
    const result = sync(root, { prune: false });

    expect(result.messages).toEqual(["Hello, {name}!", "Welcome", items]);
    expect(read(root, "locales/fr.json")).toBe(`{
  "Hello, {name}!": "",
  "Welcome": "Bienvenue",
  "${items}": ""
}
`);
    expect(Object.values(catalog(root, "ja"))).toEqual(["", "", ""]);
  });

  test("a message the source dropped stays until it is pruned", () => {
    const root = project("sync-prune", {
      "src/app.ts": app,
      "locales/fr.json": JSON.stringify({ Welcome: "Bienvenue", Goodbye: "Au revoir" }),
    });
    sync(root, { prune: false });
    expect(catalog(root, "fr").Goodbye).toBe("Au revoir");

    sync(root, { prune: true });
    expect(Object.keys(catalog(root, "fr"))).toEqual([
      "Hello, {name}!",
      "Welcome",
      items,
    ]);
    expect(catalog(root, "fr").Welcome).toBe("Bienvenue");
  });

  test("files that are already in step are not rewritten", () => {
    const root = project("sync-idle", { "src/app.ts": app, "locales/fr.json": "{}" });
    sync(root, { prune: true });
    const paths = ["fr.json", "index.js", "index.d.ts"].map((name) => join(root, "locales", name));
    const before = paths.map((path) => statSync(path).mtimeMs);
    Bun.sleepSync(5);
    sync(root, { prune: true });
    expect(paths.map((path) => statSync(path).mtimeMs)).toEqual(before);
  });

  test("nothing is written while a file does not parse", () => {
    const root = project("sync-broken", {
      "src/app.ts": app,
      "src/broken.ts": 'import { t } from "dicto";\nt("Half typed"',
      "locales/fr.json": JSON.stringify({ Welcome: "Bienvenue", Goodbye: "Au revoir" }),
    });
    const result = sync(root, { prune: true });

    expect(result.complete).toBe(false);
    expect(result.catalogs).toEqual([]);
    expect(result.problems).toEqual([
      { path: "src/broken.ts", line: 2, column: 15, kind: "syntax" },
    ]);
    expect(catalog(root, "fr")).toEqual({ Welcome: "Bienvenue", Goodbye: "Au revoir" });
  });

  test("ignored files hold no messages", () => {
    const root = project("sync-ignore", {
      ".gitignore": "/generated\n",
      "src/app.ts": app,
      "generated/api.ts": 'import { t } from "dicto";\nt("Generated");',
      "dist/app.js": 'import { t } from "dicto";\nt("Built");',
      "src/drafts/.gitignore": "*.draft.ts\n",
      "src/drafts/idea.draft.ts": 'import { t } from "dicto";\nt("Draft");',
      "src/drafts/kept.ts": 'import { t } from "dicto";\nt("Kept");',
    });
    expect(sync(root, { prune: true }).messages).toEqual([
      "Hello, {name}!",
      "Kept",
      "Welcome",
      items,
    ]);
  });

  test("the generated module knows the locales and the messages", async () => {
    const root = project("sync-generated", {
      "src/app.ts": app,
      "locales/fr.json": JSON.stringify({
        Welcome: "Bienvenue",
        "Hello, {name}!": "Bonjour, {name} !",
      }),
      "locales/pt-BR.json": "{}",
      "locales/broken.json": "[1, 2]",
    });
    sync(root, { prune: true });

    const declarations = read(root, "locales/index.d.ts");
    expect(declarations).toContain('export type Locale = "en" | "fr" | "pt-BR";');
    expect(declarations).toContain(`    message:
      | "Hello, {name}!"
      | "Welcome"
      | "${items}";`);

    const { locales, setLocale } = await import(join(root, "locales/index.js"));
    expect(locales).toEqual(["en", "fr", "pt-BR"]);
    await setLocale("fr");
    expect(getLocale()).toBe("fr");
    expect(t("Welcome")).toBe("Bienvenue");
    expect(t("Hello, {name}!", { name: "Ada" })).toBe("Bonjour, Ada !");
    expect(await setLocale("en", () => t("Welcome"))).toBe("Welcome");
    for (const unknown of ["de", "constructor"]) {
      await expect(setLocale(unknown)).rejects.toThrow(`dicto: there is no "${unknown}" catalog`);
    }
  });

  test("a project without messages or catalogs still syncs", () => {
    const root = project("sync-empty", { "src/app.ts": "export {};\n", "locales/fr.json": "{}" });
    sync(root, { prune: true });
    expect(read(root, "locales/fr.json")).toBe("{}\n");
    expect(read(root, "locales/index.d.ts")).toContain("message: never;");

    const bare = project("sync-bare", { "src/app.ts": app });
    expect(sync(bare, { prune: true }).catalogs).toEqual([]);
    expect(() => statSync(join(bare, "locales"))).toThrow();
  });
});

describe("verify", () => {
  test("it counts the untranslated and explains the invalid", () => {
    const root = project("verify", {
      "src/app.ts": `${app}t("Read the <link>docs</link>.", { link: String });\nt("{broken");\n`,
      "locales/fr.json": JSON.stringify({
        "Hello, {name}!": "Bonjour, {name} !",
        "Read the <link>docs</link>.": "Lisez la <link>documentation</link>.",
        Welcome: "Bienvenue",
        [items]: "{count, plural, one {# élément} many {# d'éléments} other {# éléments}}",
      }),
      "locales/ja.json": JSON.stringify({
        "Hello, {name}!": "こんにちは、{namae}さん",
        "Read the <link>docs</link>.": "ドキュメントを読んでください。",
        [items]: "{count, plural, other {#個}}",
      }),
      "locales/de.json": JSON.stringify({
        "Hello, {name}!": "Hallo, {name",
        Welcome: "Willkommen, {name}",
        [items]: "{count, plural, other {# Artikel}}",
      }),
      "locales/es.json": '{ "Welcome": 1 }',
      "locales/not a locale.json": "{}",
    });
    const verdicts = verify(sync(root, { prune: true }));

    expect(verdicts).toEqual([
      {
        locale: "en",
        untranslated: 0,
        invalid: [{ message: "{broken", reason: 'does not parse: expected "," at character 8' }],
      },
      {
        locale: "de",
        untranslated: 1,
        invalid: [
          { message: "Hello, {name}!", reason: 'does not parse: expected "," at character 13' },
          { message: "Welcome", reason: "has unknown {name}" },
          { message: items, reason: "{count} is missing the forms one" },
        ],
      },
      { locale: "es", untranslated: 0, invalid: [{ reason: "is not a JSON object of strings" }] },
      { locale: "fr", untranslated: 0, invalid: [] },
      {
        locale: "ja",
        untranslated: 1,
        invalid: [
          { message: "Hello, {name}!", reason: "is missing {name}" },
          { message: "Read the <link>docs</link>.", reason: "is missing <link>" },
        ],
      },
      { locale: "not a locale", untranslated: 0, invalid: [{ reason: "is not a locale" }] },
    ]);
  });
});
