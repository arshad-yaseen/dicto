import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import dicto from "dicto/vite";
import { build, createServer } from "vite";
import { catalog, project, read, write } from "./fixture.ts";

const main = `import { t } from "dicto";
import { setLocale } from "../locales/index.js";

export async function render(locale: "en" | "fr"): Promise<string> {
  return setLocale(locale, () => t("Hello, {name}!", { name: "Ada" }));
}
`;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  const holds = (): boolean => {
    try {
      return condition();
    } catch {
      return false;
    }
  };
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

test("the dev server follows each saved file", async () => {
  const root = project("vite-dev", {
    ".gitignore": "/generated\n",
    "src/main.ts": main,
    "locales/fr.json": JSON.stringify({ "Hello, {name}!": "Bonjour, {name} !" }),
  });
  const warnings: string[] = [];
  const server = await createServer({
    root,
    configFile: false,
    plugins: [dicto()],
    server: { middlewareMode: true, ws: false },
    appType: "custom",
    customLogger: {
      info() {},
      warn: (message) => warnings.push(message),
      warnOnce() {},
      error() {},
      clearScreen() {},
      hasErrorLogged: () => false,
      hasWarned: false,
    },
  });
  const types = () => read(root, "locales/index.d.ts");
  try {
    await until(() => types().includes('| "Hello, {name}!"'));

    write(root, { "src/page.ts": 'import { t } from "dicto";\nt("Saved");\nt(String(1));\n' });
    await until(() => "Saved" in catalog(root, "fr"));
    expect(catalog(root, "fr")).toEqual({ "Hello, {name}!": "Bonjour, {name} !", Saved: "" });
    expect(types()).toContain('| "Saved"');
    expect(warnings).toEqual(["dicto: src/page.ts:3:3 t must be called with a string literal"]);

    write(root, { "src/page.ts": 'import { t } from "dicto";\nt("Renamed");\n' });
    await until(() => "Renamed" in catalog(root, "fr"));
    expect(Object.keys(catalog(root, "fr"))).toEqual(["Hello, {name}!", "Renamed", "Saved"]);
    expect(types()).not.toContain('"Saved"');

    write(root, { "src/page.ts": 'import { t } from "dicto";\nt("Half typed"' });
    write(root, { "src/other.ts": 'import { t } from "dicto";\nt("While broken");\n' });
    await until(() => "While broken" in catalog(root, "fr"));
    expect(types()).toContain('| "Renamed"');

    write(root, { "generated/api.ts": 'import { t } from "dicto";\nt("Generated");\n' });
    rmSync(join(root, "src/other.ts"));
    await until(() => !types().includes('"While broken"'));
    expect("While broken" in catalog(root, "fr")).toBe(true);
    expect(types()).not.toContain('"Generated"');
  } finally {
    await server.close();
  }
});

test("a build bundles the generated module and splits each catalog out", async () => {
  const root = project("vite-build", {
    "src/main.ts": main,
    "locales/fr.json": JSON.stringify({ "Hello, {name}!": "Bonjour, {name} !" }),
    "locales/index.js": `import { activate } from "dicto";
const catalogs = {
  __proto__: null,
  "en": async () => ({ default: {} }),
  "fr": () => import("./fr.json", { with: { type: "json" } }),
};
export const locales = Object.keys(catalogs);
export function setLocale(locale, scope) {
  return activate(locale, catalogs[locale], scope);
}
`,
  });
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [dicto()],
    build: { ssr: "src/main.ts", outDir: "out" },
  });
  const { render } = await import(join(root, "out/main.js"));
  expect(await render("fr")).toBe("Bonjour, Ada !");
  expect(await render("en")).toBe("Hello, Ada!");
  expect(read(root, "out/main.js")).not.toContain("Bonjour");
});
