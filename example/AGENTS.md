## Translations

Messages are written in the code as `t("...")`, in ICU MessageFormat. `locales/<language>.json`
maps each message to its translation. An empty value means it still needs translating.

- Fill in empty values only. Never change, add, or remove keys.
- Keep `{name}` arguments and `<tag>...</tag>` tags. Tags may move to fit the sentence.
- In `{count, plural, ...}`, write every plural form the language uses.
- Run `npx dicto` when done and fix what it reports.
