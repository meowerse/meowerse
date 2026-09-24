// Cat3D.tsx — tiny decorative 3D cat (spec §4). Poster first; the WebGL2 renderer loads lazily when visible,
// never on reduced motion / save-data, and any failure just leaves the poster.
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import poster from "./cat-poster.webp";
import binUrl from "./cat.bin?url";

const skip = () =>
  typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

export function Cat3D({ size = 160, className }: { size?: number; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (skip() || typeof IntersectionObserver === "undefined") return;
    let api: { setAim(x: number, y: number): void; destroy(): void } | null = null;
    let gone = false;
    const onMove = (e: PointerEvent) => {
      const r = root.current!.getBoundingClientRect();
      api?.setAim((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), -((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
    };
    const io = new IntersectionObserver(async ([e]) => {
      if (!e?.isIntersecting || api || gone) return;
      io.disconnect();
      try {
        const [{ mount }, buf] = await Promise.all([import("./renderer"), fetch(binUrl).then((r) => r.arrayBuffer())]);
        if (gone || !canvas.current) return;
        const s = getComputedStyle(root.current!);
        api = mount(canvas.current, buf, { color: s.getPropertyValue("--cat-color").trim() || "#14995a", light: "#63d396" });
        if (!api) return;
        canvas.current.addEventListener("webglcontextlost", () => setLive(false), { once: true });
        addEventListener("pointermove", onMove, { passive: true });
        setLive(true);
      } catch { /* network or GL failure: the poster stays — decorative only */ }
    }, { rootMargin: "200px" });
    io.observe(root.current!);
    return () => { gone = true; io.disconnect(); removeEventListener("pointermove", onMove); api?.destroy(); };
  }, []);

  return (
    <div ref={root} className={cx("mw-cat3d", className)} style={{ width: size, height: size }} aria-hidden="true">
      <img src={typeof poster === "string" ? poster : poster.src} alt="" width={size} height={size} hidden={live} decoding="async" />
      <canvas ref={canvas} hidden={!live} />
    </div>
  );
}
