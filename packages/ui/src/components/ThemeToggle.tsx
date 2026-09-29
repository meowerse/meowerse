import { useEffect, useState } from "react";
import { resolvedTheme, toggleTheme } from "../lib/theme";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

/** a 44 px button that switches between the dark and light themes and remembers the choice. */
export function ThemeToggle({ className }: {
  /** extra class names to append. */
  className?: string;
}) {
  // Start with dark (the server default and most common case). The effect corrects this
  // after mount if the client prefers light, avoiding hydration mismatches.
  const [dark, setDark] = useState(true);
  useEffect(() => { setDark(resolvedTheme() === "dark"); }, []);
  return (
    <button type="button" className={cx("mw-themetoggle", className)} aria-label={dark ? "switch to light theme" : "switch to dark theme"}
      onClick={() => { toggleTheme(); setDark(resolvedTheme() === "dark"); }}>
      <Icon name={dark ? "sun" : "moon"} size={18} />
    </button>
  );
}
