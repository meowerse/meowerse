import { Cursor } from "./Cursor";
import { cx } from "../lib/cx";
export function Wordmark({ name, href, className }: { name: "meowerse" | "meowsenger" | "auth" | "ui"; href?: string; className?: string }) {
  const inner = <>{name}_<Cursor /></>;
  return href
    ? <a className={cx("mw-wordmark", className)} href={href} aria-label={`${name} home`}>{inner}</a>
    : <span className={cx("mw-wordmark", className)}>{inner}</span>;
}
