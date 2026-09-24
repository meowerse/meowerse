// Vanilla lifecycle of the decorative Cat3D (spec §4), shared by the React <Cat3D> and by pages that
// render its markup statically (meow.alxnko.dev ships no React on its home page). The poster stays
// until the WebGL2 renderer loads: lazily, on first visibility, never under reduced motion or
// save-data. Any failure just leaves the poster. Pointer tracking runs only while the cat is in view.
import { primitive } from "../../design/tokens.json";
import binUrl from "./cat.bin?url";

type Api = { setAim(x: number, y: number): void; kick(): void; destroy(): void };

const skip = () =>
  typeof matchMedia === "undefined" || matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

/** Starts the lazy renderer for one `.mw-cat3d` root (poster <img> + hidden <canvas>). Returns a cleanup. */
export function attachCat3D(root: HTMLElement): () => void {
  const canvas = root.querySelector("canvas");
  if (!canvas || skip() || typeof IntersectionObserver === "undefined") return () => {};
  const abort = new AbortController();
  let api: Api | null = null;
  let visible = false, loading = false, gone = false;
  let ro: ResizeObserver | undefined;
  const setLive = (on: boolean) => { root.classList.toggle("mw-cat3d--live", on); canvas.hidden = !on; };
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    api?.setAim((e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), -((e.clientY - (r.top + r.height / 2)) / (innerHeight / 2)));
  };
  const track = (on: boolean) =>
    on ? addEventListener("pointermove", onMove, { passive: true }) : removeEventListener("pointermove", onMove);
  const stop = () => { track(false); io.disconnect(); ro?.disconnect(); api?.destroy(); api = null; };
  const load = async () => {
    loading = true;
    try {
      const [{ mount }, buf] = await Promise.all([
        import("./renderer"),
        fetch(binUrl, { signal: abort.signal }).then((r) => r.arrayBuffer()),
      ]);
      if (gone) return;
      const css = getComputedStyle(root);
      const color = css.getPropertyValue("--cat-color").trim() || primitive.scene.cat;
      const light = css.getPropertyValue("--cat-edge").trim() || primitive.scene.catEdge;
      api = mount(canvas, buf, { color, light });
      if (!api) return io.disconnect();
      canvas.addEventListener("webglcontextlost", () => { stop(); setLive(false); }, { once: true });
      if (typeof ResizeObserver !== "undefined") (ro = new ResizeObserver(() => api?.kick())).observe(canvas);
      track(visible);
      setLive(true);
      api.kick(); // first frame once the canvas is displayed (it measured 0×0 while hidden)
    } catch { /* network or GL failure: the poster stays — decorative only */ }
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e?.isIntersecting === true;
    if (api) track(visible);
    else if (visible && !loading) void load();
  }, { rootMargin: "200px" });
  io.observe(root);
  return () => { gone = true; abort.abort(); stop(); };
}

/** Attaches every `.mw-cat3d` in `doc` except `.mw-cat3d--static` ones (the documented still fallback). */
export function attachAllCat3D(doc: ParentNode = document): () => void {
  const offs = [...doc.querySelectorAll<HTMLElement>(".mw-cat3d:not(.mw-cat3d--static)")].map(attachCat3D);
  return () => offs.forEach((off) => off());
}
