import { Cursor } from "./Cursor";
import { cx } from "../lib/cx";
/** an app's name in VT323 with an underscore and a blinking block cursor. */
export function Wordmark({ name, href, className }: {
  /** which app's name to render. */
  name: "meowerse" | "meowsenger" | "auth" | "ui";
  /** turns the wordmark into a home link, named "<name> home". */
  href?: string;
  /** extra class names to append. */
  className?: string;
}) {
  const inner = <>{name}_<Cursor /></>;
  return href
    ? <a className={cx("mw-wordmark", className)} href={href} aria-label={`${name} home`}>{inner}</a>
    : <span className={cx("mw-wordmark", className)}>{inner}</span>;
}
