"use client";

import { useState } from "react";
import { t } from "dicto";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      {t("{count, plural, one {# click} other {# clicks}}", { count })}
    </button>
  );
}
