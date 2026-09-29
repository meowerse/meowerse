import { afterEach, describe, expect, it, vi } from "vitest";
import tokens from "../../design/tokens.json";
import { attachAllCat3D, attachCat3D } from "./attach";

const mount = vi.hoisted(() => vi.fn());
vi.mock("./renderer", () => ({ mount }));

afterEach(() => { vi.unstubAllGlobals(); mount.mockReset(); document.body.replaceChildren(); });

function root(extraClass?: string) {
  const el = document.createElement("div");
  el.className = extraClass ? `mw-cat3d ${extraClass}` : "mw-cat3d";
  const canvas = document.createElement("canvas");
  canvas.hidden = true;
  el.append(document.createElement("img"), canvas);
  document.body.append(el);
  return el;
}

function env(reduce = false) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })));
  const observed: Element[] = [];
  let fire: (v: boolean) => void = () => {};
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) { fire = (v) => cb([{ isIntersecting: v }]); }
    observe(el: Element) { observed.push(el); }
    disconnect() {}
  });
  return { observed, visible: async () => { fire(true); await new Promise((r) => setTimeout(r, 0)); } };
}

describe("attachCat3D", () => {
  it("leaves the poster alone under reduced motion", () => {
    const e = env(true);
    attachCat3D(root());
    expect(e.observed).toHaveLength(0);
  });
  it("is a no-op for markup without a canvas", () => {
    const e = env();
    const el = document.createElement("div");
    expect(attachCat3D(el)).toBeTypeOf("function");
    expect(e.observed).toHaveLength(0);
  });
  it("goes live on first visibility with the token colours, then cleans up", async () => {
    const api = { setAim: vi.fn(), kick: vi.fn(), destroy: vi.fn() };
    mount.mockReturnValue(api);
    const e = env();
    const el = root();
    const off = attachCat3D(el);
    await e.visible();
    expect(mount).toHaveBeenCalledWith(el.querySelector("canvas"), expect.any(ArrayBuffer),
      { color: tokens.primitive.scene.cat, light: tokens.primitive.scene.catEdge });
    expect(el).toHaveClass("mw-cat3d--live");
    expect(el.querySelector("canvas")!.hidden).toBe(false);
    expect(api.kick).toHaveBeenCalledTimes(1);
    off();
    expect(api.destroy).toHaveBeenCalled();
  });
});

describe("attachAllCat3D", () => {
  it("attaches every cat except the documented still fallback (.mw-cat3d--static)", () => {
    const e = env();
    root();
    root("mw-cat3d--static");
    root();
    attachAllCat3D();
    expect(e.observed).toHaveLength(2);
  });
});
