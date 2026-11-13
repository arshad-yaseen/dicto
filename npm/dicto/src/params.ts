import type { Register } from "./index.ts";

export type Message = Register extends { message: infer Known extends string } ? Known : never;
export type Node = Register extends { node: infer Known } ? Known : unknown;

type Tag = (children: Node) => Node;
type Space = " " | "\n" | "\t" | "\r";
type Frame = "body" | "options";
type Entry = [name: string, type: [unknown], tag: boolean];

type Trim<S extends string> = S extends `${Space}${infer R}`
  ? Trim<R>
  : S extends `${infer R}${Space}`
    ? Trim<R>
    : S;

type Scan<S extends string, Stack extends Frame[] = [], Out extends Entry = never> =
  S extends `${string}${"{" | "}" | "<" | "'"}${string}`
    ? S extends `${infer C}${infer Rest}`
      ? Stack extends [...infer Up extends Frame[], "options"]
        ? C extends "{"
          ? Scan<Rest, [...Stack, "body"], Out>
          : C extends "}"
            ? Scan<Rest, Up, Out>
            : Scan<Rest, Stack, Out>
        : C extends "{"
          ? Argument<Rest, Stack, Out>
          : C extends "}"
            ? Scan<Rest, Stack extends [...infer Up extends Frame[], "body"] ? Up : Stack, Out>
            : C extends "<"
              ? TagOf<Rest, Stack, Out>
              : C extends "'"
                ? Quoted<Rest, Stack, Out>
                : Scan<Rest, Stack, Out>
      : Out
    : Out;

type Argument<S extends string, Stack extends Frame[], Out extends Entry> =
  S extends `${infer Head}}${infer After}`
    ? Head extends `${infer Name},${infer Kind},${string}`
      ? S extends `${string},${string},${infer Options}`
        ? Scan<
            Options,
            [...Stack, "options"],
            Out | [Trim<Name>, [Trim<Kind> extends "select" ? string : number], false]
          >
        : Out
      : Scan<After, Stack, Out | [Trim<Head>, [string | number], false]>
    : Out;

type TagOf<S extends string, Stack extends Frame[], Out extends Entry> =
  S extends `${infer Name}>${infer Rest}`
    ? Name extends "" | `${string}${Space | "<" | "{" | "}"}${string}`
      ? Scan<S, Stack, Out>
      : Name extends `/${string}`
        ? Scan<Rest, Stack, Out>
        : Scan<Rest, Stack, Out | [Name extends `${infer Own}/` ? Own : Name, [Tag], true]>
    : Out;

type Quoted<S extends string, Stack extends Frame[], Out extends Entry> = S extends `'${infer Rest}`
  ? Scan<Rest, Stack, Out>
  : S extends `${"{" | "}" | "<" | ">" | "#"}${string}`
    ? S extends `${string}'${infer Rest}`
      ? Scan<Rest, Stack, Out>
      : Out
    : Scan<S, Stack, Out>;

type Both<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;

type Params<E extends Entry> = {
  [Name in E[0]]: Both<Extract<E, [Name, [unknown], boolean]>[1]> extends [infer T] ? T : never;
};

export type Arguments<M extends string> = string extends M
  ? [params?: Readonly<Record<string, unknown>>]
  : [Scan<M>] extends [never]
    ? []
    : [params: Params<Scan<M>>];

export type Result<M extends string> = [Extract<Scan<M>, [string, [unknown], true]>] extends [never]
  ? string
  : Node;
