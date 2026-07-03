import { cx } from "../lib/cx";

export function Avatar({ name, size = "md", className }:
  { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span aria-label={name} className={cx("mw-avatar", `mw-avatar--${size}`, className)}>
      <span aria-hidden="true" className="mono" data-case="preserve">{initial}</span>
    </span>
  );
}
