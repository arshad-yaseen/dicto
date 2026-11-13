import type { ReactNode } from "react";
import { t } from "dicto";
import "dicto/react";

const plain: string = t("Plain | with // marks");
const greeting: string = t("Hello, {name}!", { name: "Ada" });
t("{first} then {second}", { first: 1, second: "two" });
t("{count, plural, =0 {No items} one {# item} other {# items}}", { count: 2 });
t("{place, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", { place: 3 });
t("{gender, select, female {She} male {He} other {They}} replied", { gender: "female" });
t("{gender, select, other {{count, plural, one {# cat} other {# cats}}}}", { gender: "x", count: 1 });
t("You have {count} {count, plural, one {message} other {messages}}", { count: 2 });
t("Don't use '{braces}' or ''quotes''");
const rich: ReactNode = t("Read the <link>docs</link>.<br/>", {
  link: (children) => children,
  br: () => null,
});

// @ts-expect-error a parameter is missing
t("Hello, {name}!");
// @ts-expect-error a parameter is misnamed
t("Hello, {name}!", { nom: "Ada" });
// @ts-expect-error a parameter the message does not have
t("Hello, {name}!", { name: "Ada", title: "Countess" });
// @ts-expect-error the count is a number
t("{count, plural, one {# item} other {# items}}", { count: "2" });
// @ts-expect-error a plain message takes no parameters
t("Plain", {});
// @ts-expect-error a tag needs its function
t("Read the <link>docs</link>.");
// @ts-expect-error a quoted brace is not a parameter
t("Use '{braces}'", { braces: 1 });
// @ts-expect-error an option body is not a parameter
t("{count, plural, one {item} other {items}}", { count: 1, item: 1 });
// @ts-expect-error a message with tags is not a string
const notString: string = t("A <b>bold</b> claim", { b: (children) => children });

export { greeting, notString, plain, rich };
