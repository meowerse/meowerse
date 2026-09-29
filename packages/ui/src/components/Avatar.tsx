import { cx } from "../lib/cx";

/** a rounded square with a person's initial, in three sizes. */
export function Avatar({ name, size = "md", decorative = false, className }: {
  /** the person's name; its first character becomes the visible initial and its accessible name. */
  name: string;
  /** the avatar's size. */
  size?: "sm" | "md" | "lg";
  /** true when the name is already visible next to the avatar: it is then hidden from assistive tech,
   *  so a screen reader doesn't read the name twice. Leave it false when the avatar stands alone. */
  decorative?: boolean;
  /** extra class names to append. */
  className?: string;
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name })}
      className={cx("mw-avatar", `mw-avatar--${size}`, className)}>
      <span aria-hidden="true" className="mono" data-case="preserve">{initial}</span>
    </span>
  );
}
