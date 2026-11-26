import type { CSSProperties } from "react";
import { cx } from "../lib/cx";

/** a decorative placeholder block that holds a loading item's exact box, so content swaps in without moving anything. */
export function Skeleton({ width, height, className }: {
  /** css width of the block (default: the full width of its container). */
  width?: CSSProperties["width"];
  /** css height of the block; set it to the height the loaded content will take (default 1em). */
  height?: CSSProperties["height"];
  /** extra class names to append. */
  className?: string;
}) {
  // aria-hidden: name the loading region once (role="status" + aria-label on its wrapper), not each block.
  // No style attribute unless a size is given: a statically rendered page under a strict CSP can then size it with a class instead.
  return <span aria-hidden="true" className={cx("mw-skeleton", className)} style={width === undefined && height === undefined ? undefined : { width, height }} />;
}
