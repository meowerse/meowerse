import { cx } from "../lib/cx";

/** a rounded square with a person's initial, in three sizes. */
export function Avatar({ name, size = "md", className }: {
  /** the person's name; its first character becomes the visible initial and its accessible name. */
  name: string;
  /** the avatar's size. */
  size?: "sm" | "md" | "lg";
  /** extra class names to append. */
  className?: string;
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span role="img" aria-label={name} className={cx("mw-avatar", `mw-avatar--${size}`, className)}>
      <span aria-hidden="true" className="mono" data-case="preserve">{initial}</span>
    </span>
  );
}
