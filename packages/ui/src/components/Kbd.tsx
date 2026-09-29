import type { ReactNode } from "react";
/** a keycap for keyboard shortcuts in text. */
export function Kbd({ children }: {
  /** the key name, written as it appears on a keyboard. */
  children: ReactNode;
}) {
  return <kbd className="mw-kbd">{children}</kbd>;
}
