export const sourceLocale = "en";

export type Kind = "plural" | "selectordinal" | "select";

export type Node =
  | string
  | { type: "argument"; name: string }
  | { type: "pound" }
  | { type: "choice"; name: string; kind: Kind; options: Map<string, Node[]> }
  | { type: "tag"; name: string; children: Node[] | undefined };

const kinds = new Set<string>(["plural", "selectordinal", "select"]);
const categoryOrder = ["zero", "one", "two", "few", "many", "other"];
const openingTag = /<([A-Za-z][\w-]*)(\/?)>/y;
const closingTag = /<\/([A-Za-z][\w-]*)>/y;
const quotable = "{}<>#";

export function parse(source: string): Node[] {
  let index = 0;

  const fail = (reason: string): never => {
    throw new SyntaxError(`${reason} at character ${index + 1}`);
  };
  const at = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = index;
    return pattern.exec(source);
  };
  const skipSpace = (): void => {
    while (/\s/.test(source[index] ?? "")) index += 1;
  };
  const word = (): string => {
    const start = index;
    while (index < source.length && !/[\s{},]/.test(source[index]!)) index += 1;
    return source.slice(start, index);
  };
  const expect = (text: string): void => {
    if (!source.startsWith(text, index)) fail(`expected "${text}"`);
    index += text.length;
  };

  const sequence = (end: string | undefined, pound: boolean): Node[] => {
    const nodes: Node[] = [];
    let text = "";
    const push = (node: Node): void => {
      if (text) nodes.push(text);
      nodes.push(node);
      text = "";
    };
    while (index < source.length && !(end && source.startsWith(end, index))) {
      const char = source[index]!;
      const tag = char === "<" ? at(openingTag) : null;
      if (char === "{") {
        push(argument(pound));
      } else if (char === "#" && pound) {
        index += 1;
        push({ type: "pound" });
      } else if (tag) {
        const [match, name = "", selfClosing] = tag;
        index += match.length;
        const children = selfClosing ? undefined : sequence(`</${name}>`, pound);
        if (children) expect(`</${name}>`);
        push({ type: "tag", name, children });
      } else if (char === "}" || (char === "<" && at(closingTag))) {
        fail(`unexpected "${char === "}" ? char : at(closingTag)![0]}"`);
      } else if (char === "'" && source[index + 1] === "'") {
        text += "'";
        index += 2;
      } else if (char === "'" && quotable.includes(source[index + 1] ?? "")) {
        const close = source.indexOf("'", index + 1);
        text += source.slice(index + 1, close < 0 ? undefined : close);
        index = close < 0 ? source.length : close + 1;
      } else {
        text += char;
        index += 1;
      }
    }
    if (end && index >= source.length) fail(`expected "${end}"`);
    if (text) nodes.push(text);
    return nodes;
  };

  const argument = (pound: boolean): Node => {
    index += 1;
    skipSpace();
    const name = word();
    if (!name) fail("expected an argument name");
    skipSpace();
    if (source[index] === "}") {
      index += 1;
      return { type: "argument", name };
    }
    expect(",");
    skipSpace();
    const kind = word();
    if (!kinds.has(kind)) fail("expected plural, selectordinal, or select");
    skipSpace();
    expect(",");
    skipSpace();
    const options = new Map<string, Node[]>();
    while (source[index] !== "}") {
      const key = word();
      if (!key) fail("expected an option");
      if (options.has(key)) fail(`duplicate option "${key}"`);
      skipSpace();
      expect("{");
      options.set(key, sequence("}", pound || kind !== "select"));
      expect("}");
      skipSpace();
    }
    index += 1;
    if (!options.has("other")) fail(`{${name}} needs an "other" option`);
    return { type: "choice", name, kind: kind as Kind, options };
  };

  return sequence(undefined, false);
}

export function pluralCategories(locale: string, kind: Kind): string[] {
  const type = kind === "selectordinal" ? "ordinal" : "cardinal";
  const categories: string[] = new Intl.PluralRules(locale, { type }).resolvedOptions()
    .pluralCategories;
  return categoryOrder.filter((category) => categories.includes(category));
}
