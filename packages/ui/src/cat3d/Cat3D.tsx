// Cat3D.tsx — tiny decorative 3D cat (spec §4). Poster first; the WebGL2 renderer loads lazily on first
// visibility, never on reduced motion / save-data, and any failure just leaves the poster.
// No inline style (strict style-src): the in-flow poster <img width/height> sizes the box, the canvas overlays it.
// Pointer tracking runs only while the cat is in view.
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import poster from "./cat-poster.webp";
import binUrl from "./cat.bin?url";

type Api = { setAim(x: number, y: number): void; kick(): void; destroy(): void };

const skip = () =>
  typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

export function Cat3D({ size = 160, className }: { size?: number; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const api = useRef<Api | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (skip() || typeof IntersectionObserver === "undefined") return;
    const abort = new AbortController();
    let visible = false, loading = false, gone = false;
    let ro: ResizeObserver | undefined;
    const onMove = (e: PointerEvent) => {
      const r = root.current!.getBoundingClientRect();
      api.current?.setAim((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), -((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
    };
    const track = (on: boolean) =>
      on ? addEventListener("pointermove", onMove, { passive: true }) : removeEventListener("pointermove", onMove);
    const stop = () => {
      track(false); io.disconnect(); ro?.disconnect();
      api.current?.destroy(); api.current = null;
    };
    const load = async () => {
      loading = true;
      try {
        const [{ mount }, buf] = await Promise.all([
          import("./renderer"),
          fetch(binUrl, { signal: abort.signal }).then((r) => r.arrayBuffer()),
        ]);
        const c = canvas.current;
        if (gone || !c) return;
        const color = getComputedStyle(root.current!).getPropertyValue("--cat-color").trim() || "#14995a";
        api.current = mount(c, buf, { color, light: "#63d396" });
        if (!api.current) return io.disconnect();
        c.addEventListener("webglcontextlost", () => { stop(); setLive(false); }, { once: true });
        if (typeof ResizeObserver !== "undefined") (ro = new ResizeObserver(() => api.current?.kick())).observe(c);
        track(visible);
        setLive(true);
      } catch { /* network or GL failure: the poster stays — decorative only */ }
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting === true;
      if (api.current) track(visible);
      else if (visible && !loading) void load();
    }, { rootMargin: "200px" });
    io.observe(root.current!);
    return () => { gone = true; abort.abort(); stop(); };
  }, []);

  // first frame once the canvas is displayed (it measured 0×0 while hidden)
  useEffect(() => { if (live) api.current?.kick(); }, [live]);

  return (
    <div ref={root} className={cx("mw-cat3d", live && "mw-cat3d--live", className)} aria-hidden="true">
      <img src={typeof poster === "string" ? poster : poster.src} alt="" width={size} height={size} decoding="async" />
      <canvas ref={canvas} hidden={!live} />
    </div>
  );
}
