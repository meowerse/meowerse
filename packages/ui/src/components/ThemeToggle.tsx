import { useEffect, useState } from "react";
import { resolvedTheme, toggleTheme } from "../lib/theme";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export function ThemeToggle({ className }: { className?: string }) {
  // Start with dark (the server default and most common case). The effect corrects this
  // after mount if the client prefers light, avoiding hydration mismatches.
  const [dark, setDark] = useState(true);
  useEffect(() => { setDark(resolvedTheme() === "dark"); }, []);
  return (
    <button type="button" className={cx("mw-themetoggle", className)} aria-label="toggle theme"
      onClick={() => { toggleTheme(); setDark(resolvedTheme() === "dark"); }}>
      <Icon name={dark ? "sun" : "moon"} size={18} />
    </button>
  );
}
