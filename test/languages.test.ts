import { expect, test } from "bun:test";
import { languageOf, languages, named, search } from "../npm/dicto/src/cli/languages.ts";

const all = languages();
const codes = (query: string) => search(all, query).map(({ code }) => code);

test("the list has each language once, by its current code", () => {
  const listed = all.map(({ code }) => code);
  expect(new Set(listed).size).toBe(listed.length);
  expect(listed).toEqual(expect.arrayContaining(["fr", "ja", "ar", "he", "pt-BR", "zh-Hant"]));
  expect(listed).not.toContain("iw");
  const japanese = all.find(({ code }) => code === "ja");
  expect(japanese).toEqual({ code: "ja", name: "Japanese", native: "日本語" });
});

test("a code, a name, or a native name finds its language first", () => {
  expect(codes("fr")[0]).toBe("fr");
  expect(codes("French")[0]).toBe("fr");
  expect(codes("  français ")[0]).toBe("fr");
  expect(codes("francais")[0]).toBe("fr");
  expect(codes("日本語")[0]).toBe("ja");
  expect(codes("deu")[0]).toBe("de");
});

test("a partial name finds every language it fits", () => {
  expect(codes("portug")).toEqual(expect.arrayContaining(["pt", "pt-BR", "pt-PT"]));
  expect(codes("zzzz")).toEqual([]);
  expect(codes("")).toEqual([]);
});

test("a tag outside the list finds itself", () => {
  expect(codes("yue")).toEqual(["yue"]);
  expect(languageOf("es-MX")?.code).toBe("es-MX");
  expect(languageOf("not a tag")).toBeUndefined();
});

test("a code, a name, or a query with one match names a language", () => {
  expect(named(all, "german")?.code).toBe("de");
  expect(named(all, "japan")?.code).toBe("ja");
  expect(named(all, "PT-br")?.code).toBe("pt-BR");
  expect(named(all, "yue")?.code).toBe("yue");
  expect(named(all, "portug")).toBeUndefined();
});
