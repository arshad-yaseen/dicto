# dicto

Translations keyed by the English text. Write `t("...")`, and dicto keeps one JSON file per language in sync with your code. Your AI agent fills in the translations.

```tsx
<h1>{t("Hey, how are you?")}</h1>
```

```json
{ "Hey, how are you?": "Salut, ça va ?" }
```

- No keys, no duplicates, no unused entries
- Type-checked arguments, autocomplete for existing messages
- ICU plurals, selects, and components
- No API keys: your AI agent translates
- Native scanner: about 20 ms for 3,000 files

## Setup

```bash
npm install dicto
npx dicto add french
```

**Vite**

```ts
// vite.config.ts
import dicto from "dicto/vite";

export default defineConfig({ plugins: [dicto()] });
```

```ts
import { setLocale } from "./locales/index.js";

await setLocale("fr");
```

**Next.js**

```ts
// next.config.ts
import dicto from "dicto/next";

export default dicto({});
```

```ts
// app/[lang]/locale.ts
import { notFound } from "next/navigation";
import { lang } from "next/root-params";
import { isLocale, setLocale } from "@/locales";

export async function locale() {
  const locale = await lang();
  if (!isLocale(locale)) notFound();
  await setLocale(locale);
  return locale;
}
```

Call `await locale()` at the start of every layout and page, and wrap the root layout in `<Locale>` from `dicto/react`. See [`example/`](example).

## Messages

```tsx
t("Hello, {name}!", { name });
t("{count, plural, =0 {No items} one {# item} other {# items}}", { count });
t("{gender, select, female {She} other {They}} replied", { gender });
t("Read the <link>docs</link>.", { link: (text) => <a href="/docs">{text}</a> });
```

Messages use [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/). `t` must be called with a string literal.

## Translating

Add this to `AGENTS.md`, then ask your agent to translate.

```md
## Translations

Messages are written in the code as `t("...")`, in ICU MessageFormat. `locales/<language>.json`
maps each message to its translation. An empty value means it still needs translating.

- Fill in empty values only. Never change, add, or remove keys.
- Keep `{name}` arguments and `<tag>...</tag>` tags. Tags may move to fit the sentence.
- In `{count, plural, ...}`, write every plural form the language uses.
- Run `npx dicto` when done and fix what it reports.
```

## Commands

- `npx dicto`: sync, remove unused messages, and report anything untranslated or invalid. Fails if anything is left, for CI.
- `npx dicto add [language]`: add a language, or search for one.

## Development

```bash
bun install
bun run build
bun run test
```
