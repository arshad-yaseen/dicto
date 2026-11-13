import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const example = join(import.meta.dir, "../example");
const app = join(import.meta.dir, ".tmp/next");
const next = join(import.meta.dir, "../node_modules/.bin/next");
const rendered: Record<string, string[]> = {
  en: ["This text is rendered on the server.", "0 clicks"],
  fr: ["Ce texte est rendu sur le serveur.", "0 clic"],
  ja: ["このテキストはサーバーでレンダリングされています。", "0回クリック"],
};

const streaming = `import { Suspense } from "react";
import { t } from "dicto";
import { Counter } from "../counter";
import { locale } from "../locale";

export const dynamic = "force-dynamic";

async function Later() {
  await new Promise((done) => setTimeout(done, 20 + Math.random() * 100));
  return (
    <>
      <p>{t("This text is rendered on the server.")}</p>
      <Counter />
    </>
  );
}

export default async function Page() {
  await locale();
  return (
    <Suspense>
      <Later />
    </Suspense>
  );
}
`;

let origin: string;
let server: Bun.Subprocess;

async function page(path: string): Promise<{ status: number; html: string }> {
  const response = await fetch(origin + path);
  const html = await response.text();
  return { status: response.status, html: html.replace(/<script[\s\S]*?<\/script>/g, "") };
}

function shows(html: string, locale: string): boolean {
  return rendered[locale]!.every((text) => html.includes(`>${text}<`));
}

beforeAll(async () => {
  rmSync(app, { recursive: true, force: true });
  cpSync(example, app, {
    recursive: true,
    filter: (path) => !/[/\\](node_modules|\.next|\.git)$/.test(path),
  });
  mkdirSync(join(app, "app/[lang]/streaming"));
  writeFileSync(join(app, "app/[lang]/streaming/page.tsx"), streaming);

  const built = Bun.spawnSync([next, "build"], { cwd: app });
  if (built.exitCode !== 0) throw new Error(`${built.stdout}${built.stderr}`);

  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  origin = `http://localhost:${port}`;
  server = Bun.spawn([next, "start", "--port", String(port)], { cwd: app, stdout: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(origin).then(() => true, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("next start did not come up");
}, 180_000);

afterAll(() => server?.kill());

test("server and client components render in the language of the route", async () => {
  const { status, html } = await page("/ja");
  expect(status).toBe(200);
  expect(html).toContain(">こんにちは、Adaさん！<");
  expect(html).toContain('詳しくは<a href="/ja/about">概要ページ</a>をご覧ください。');
  expect(shows(html, "ja")).toBe(true);
  expect((await page("/xx")).status).toBe(404);
});

test("concurrent requests keep their own language through a streamed boundary", async () => {
  const locales = Object.keys(rendered);
  const requests = Array.from({ length: 150 }, (_, index) => locales[index % locales.length]!);
  const pages = await Promise.all(
    requests.map(async (locale) => ({ locale, ...(await page(`/${locale}/streaming`)) })),
  );
  const mixed = pages.filter(({ locale, html }) => {
    return !shows(html, locale) || locales.some((other) => other !== locale && shows(html, other));
  });
  expect(mixed.map(({ locale }) => locale)).toEqual([]);
}, 60_000);
