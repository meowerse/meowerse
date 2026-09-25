import { cx } from "../lib/cx";

/** a small ring that turns while something loads, in three sizes. */
export function Spinner({ size = "md", label = "loading", className }: {
  /** the spinner's size. */
  size?: "sm" | "md" | "lg";
  /** the status label read by assistive tech. */
  label?: string;
  /** extra class names to append. */
  className?: string;
}) {
  return <span role="status" aria-label={label} className={cx("mw-spinner", `mw-spinner--${size}`, className)} />;
}
