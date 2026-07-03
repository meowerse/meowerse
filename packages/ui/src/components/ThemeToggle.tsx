import { useEffect, useState } from "react";
import { resolvedTheme, toggleTheme } from "../lib/theme";
import { cx } from "../lib/cx";

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(resolvedTheme() === "dark"); }, []);
  return (
    <button type="button" className={cx("mw-themetoggle", className)} aria-label="toggle theme"
      onClick={() => { toggleTheme(); setDark(resolvedTheme() === "dark"); }}>
      <i className={dark ? "ti ti-sun" : "ti ti-moon"} aria-hidden="true" />
    </button>
  );
}
