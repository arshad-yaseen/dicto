import { createElement, Fragment, type ReactNode } from "react";

export function compose(parts: unknown[]): ReactNode {
  return createElement(Fragment, null, ...(parts as ReactNode[]));
}
