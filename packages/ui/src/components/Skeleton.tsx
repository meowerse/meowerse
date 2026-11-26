import type { CSSProperties } from "react";
import { cx } from "../lib/cx";

/** a decorative placeholder block that holds a loading item's exact box, so content swaps in without moving anything. */
export function Skeleton({ width = "100%", height, className }: {
  /** css width of the block. */
  width?: CSSProperties["width"];
  /** css height of the block; set it to the height the loaded content will take. */
  height: CSSProperties["height"];
  /** extra class names to append. */
  className?: string;
}) {
  // aria-hidden: name the loading region once (role="status" + aria-label on its wrapper), not each block.
  return <span aria-hidden="true" className={cx("mw-skeleton", className)} style={{ width, height }} />;
}
