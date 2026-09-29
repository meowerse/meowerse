// Cat3D.tsx — tiny decorative 3D cat (spec §4): the poster renders first, and attachCat3D() takes over
// (lazy WebGL2 renderer, fallbacks, pointer tracking). No inline style (strict style-src): the in-flow
// poster <img width/height> sizes the box and the canvas overlays it once live.
import { useEffect, useRef } from "react";
import { cx } from "../lib/cx";
import poster from "./cat-poster.webp";
import { attachCat3D } from "./attach";

/** the low-poly green cat from the alxnko.dev desk: a still poster first, then a tiny WebGL2 renderer whose head follows the pointer. */
export function Cat3D({ size = 160, className }: {
  /** the poster's width and height, in pixels. */
  size?: number;
  /** extra class names to append. */
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => attachCat3D(root.current!), []);
  return (
    <div ref={root} className={cx("mw-cat3d", className)} aria-hidden="true">
      <img src={typeof poster === "string" ? poster : poster.src} alt="" width={size} height={size} decoding="async" />
      <canvas hidden />
    </div>
  );
}
