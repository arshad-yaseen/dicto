import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { activate, getLocale, type Loader, t } from "../npm/dicto/src/index.ts";

const loader = (catalog: Record<string, string>): Loader => async () => ({ default: catalog });
const runtime = join(import.meta.dir, "../npm/dicto/dist/index.js");
const items = "{count, plural, =0 {No items} one {# item} other {# items}}";

const french = loader({
  "Hey, how are you?": "Salut, ça va ?",
  "Hello, {name}!": "Bonjour, {name} !",
  [items]:
    "{count, plural, =0 {Aucun article} one {# article} many {# d'articles} other {# articles}}",
  "Read the <link>docs</link>.": "Lisez la <link>documentation</link>.",
  Untranslated: "",
  Broken: "{oops",
  toString: "enChaîne",
});

describe("without a catalog", () => {
  test("a message is its own text", () => {
    expect(t("Hey, how are you?")).toBe("Hey, how are you?");
    expect(t("Docs | Acme // home")).toBe("Docs | Acme // home");
    expect(t("Don't use '{braces}' or ''quotes''")).toBe("Don't use {braces} or 'quotes'");
    expect(getLocale()).toBe("en");
  });

  test("arguments fill their names, and numbers are formatted", () => {
    expect(t("Hello, {name}!", { name: "Ada" })).toBe("Hello, Ada!");
    expect(t("{a} and {b} and {a}", { a: 1234, b: "two" })).toBe("1,234 and two and 1,234");
  });

  test("plurals pick an exact match, then the category", () => {
    expect([0, 1, 2, 1000].map((count) => t(items, { count }))).toEqual([
      "No items",
      "1 item",
      "2 items",
      "1,000 items",
    ]);
    const place = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    const places = [1, 2, 3, 4, 11].map((n) => t(place, { n }));
    expect(places).toEqual(["1st", "2nd", "3rd", "4th", "11th"]);
  });

  test("selects and nesting", () => {
    const reply =
      "{gender, select, female {She has {count, plural, one {# cat} other {# cats}}} other {They have #}}";
    expect(t(reply, { gender: "female", count: 1 })).toBe("She has 1 cat");
    expect(t(reply, { gender: "x", count: 3 })).toBe("They have #");
  });

  test("tags call their functions, and the parts combine", () => {
    const link = (children: unknown) => ({ link: children });
    expect(t("Read the <link>docs</link>.", { link })).toEqual(["Read the ", { link: "docs" }, "."]);
    expect(t("A <b>bold</b> claim", { b: (children) => `**${children}**` })).toBe("A **bold** claim");
    expect(t("Line<br/>break", { br: () => "\n" })).toBe("Line\nbreak");
  });

  test("names an object inherits are plain messages", () => {
    expect(t("constructor")).toBe("constructor");
    expect(t("__proto__")).toBe("__proto__");
  });
});

describe("with a catalog", () => {
  test("messages are translated", async () => {
    await activate("fr", french);
    expect(getLocale()).toBe("fr");
    expect(t("Hey, how are you?")).toBe("Salut, ça va ?");
    expect(t("Hello, {name}!", { name: "Ada" })).toBe("Bonjour, Ada !");
    expect(t("toString")).toBe("enChaîne");
    const link = (children: unknown) => ({ link: children });
    expect(t("Read the <link>docs</link>.", { link })).toEqual([
      "Lisez la ",
      { link: "documentation" },
      ".",
    ]);
  });

  test("plurals follow the rules and number format of the locale", async () => {
    await activate("fr", french);
    expect([0, 1, 5, 1_000_000].map((count) => t(items, { count }))).toEqual([
      "Aucun article",
      "1 article",
      "5 articles",
      "1\u202f000\u202f000 d'articles",
    ]);
  });

  test("an empty, absent, or broken translation falls back to the message", async () => {
    await activate("fr", french);
    expect(t("Untranslated")).toBe("Untranslated");
    expect(t("Never seen")).toBe("Never seen");
    expect(t("Broken")).toBe("Broken");
    expect(t("{count, plural, one {# apple} other {# apples}}", { count: 1 })).toBe("1 apple");
  });

  test("a locale without a catalog is refused", async () => {
    await expect(activate("de", undefined)).rejects.toThrow('dicto: there is no "de" catalog');
  });

  test("a catalog that fails to load is loaded again", async () => {
    let attempts = 0;
    const flaky: Loader = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return { default: { Hello: "Hallo" } };
    };
    await expect(activate("de", flaky)).rejects.toThrow("offline");
    await activate("de", flaky);
    await activate("de", flaky);
    expect(attempts).toBe(2);
    expect(t("Hello")).toBe("Hallo");
  });
});

describe("with a scope", () => {
  test("concurrent scopes keep their own locale", async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const render = async (ms: number) => {
      await pause(ms);
      return `${getLocale()}: ${t("Hey, how are you?")}`;
    };
    await activate("en", loader({}));
    const [slow, fast, outside] = await Promise.all([
      activate("fr", french, () => render(20)),
      activate("de", loader({ "Hey, how are you?": "Hey, wie geht's?" }), () => render(5)),
      render(10),
    ]);
    expect(slow).toBe("fr: Salut, ça va ?");
    expect(fast).toBe("de: Hey, wie geht's?");
    expect(outside).toBe("en: Hey, how are you?");
    expect(getLocale()).toBe("en");
  });

  test("the scope's result and errors pass through", async () => {
    expect(await activate("fr", french, () => 42)).toBe(42);
    const failing = () => {
      throw new Error("render failed");
    };
    await expect(activate("fr", french, failing)).rejects.toThrow("render failed");
  });
});

function runInNode(script: string, conditions: string[] = []): string {
  const flags = conditions.map((condition) => `--conditions=${condition}`);
  const { stdout, stderr } = Bun.spawnSync(
    ["node", ...flags, "--input-type=module", "--eval", script],
    { cwd: import.meta.dir },
  );
  expect(stderr.toString()).toBe("");
  return stdout.toString();
}

test("under React Server Components, tags render React elements", () => {
  const output = runInNode(
    `
      import { createElement } from "react";
      const { activate, getLocale, t } = await import(${JSON.stringify(runtime)});
      const french = async () => ({ default: { Hello: "Bonjour" } });
      const scoped = await activate("fr", french, () => getLocale() + " " + t("Hello"));
      const rich = t("Read <b>this</b>", { b: (children) => createElement("b", null, children) });
      console.log([scoped, getLocale(), String(rich.type), rich.props.children.length].join(", "));
    `,
    ["react-server"],
  );
  expect(output).toBe("fr Bonjour, en, Symbol(react.fragment), 2\n");
});

test("in a browser, the locale is global, since nothing can scope it", () => {
  const output = runInNode(`
    process.getBuiltinModule = undefined;
    const { activate, getLocale, t } = await import(${JSON.stringify(runtime)});
    await activate("fr", async () => ({ default: { Hello: "Bonjour" } }));
    const french = getLocale() + " " + t("Hello");
    const scoped = await activate("en", async () => ({ default: {} }), () => t("Hello"));
    console.log([french, scoped, getLocale()].join(", "));
  `);
  expect(output).toBe("fr Bonjour, Hello, en\n");
});
