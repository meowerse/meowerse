import { cx } from "../lib/cx";
export function Cursor({ blink = true }: { blink?: boolean }) {
  return <span className={cx("mw-cursor", blink && "mw-cursor--blink")} aria-hidden="true" />;
}
