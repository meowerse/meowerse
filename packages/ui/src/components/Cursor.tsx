import { cx } from "../lib/cx";
/** the block cursor of the wordmarks, blinking at 1 Hz in steps. */
export function Cursor({ blink = true }: {
  /** whether the cursor blinks; false renders it static. */
  blink?: boolean;
}) {
  return <span className={cx("mw-cursor", blink && "mw-cursor--blink")} aria-hidden="true" />;
}
