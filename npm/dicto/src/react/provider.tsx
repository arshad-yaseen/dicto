"use client";

import { createContext, Fragment, type ReactNode, use, useInsertionEffect, useMemo } from "react";
import { host } from "#host";
import { adopt, type Catalog, type Scope, scopeOf } from "../runtime.ts";
import { compose } from "./compose.ts";

const Context = createContext<Scope | undefined>(undefined);

host.compose = compose;
host.get = () => {
  try {
    return use(Context);
  } catch {
    return undefined;
  }
};

interface Props {
  locale: string;
  catalog: Catalog;
  children: ReactNode;
}

export function Provider({ locale, catalog, children }: Props): ReactNode {
  const scope = useMemo(() => scopeOf(locale, catalog), [locale, catalog]);
  useInsertionEffect(() => adopt(scope), [scope]);
  return (
    <Context value={scope}>
      <Fragment key={locale}>{children}</Fragment>
    </Context>
  );
}
