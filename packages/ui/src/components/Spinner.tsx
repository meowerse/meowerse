import { cx } from "../lib/cx";

export function Spinner({ size = "md", label = "loading", className }:
  { size?: "sm" | "md" | "lg"; label?: string; className?: string }) {
  return <span role="status" aria-label={label} className={cx("mw-spinner", `mw-spinner--${size}`, className)} />;
}
