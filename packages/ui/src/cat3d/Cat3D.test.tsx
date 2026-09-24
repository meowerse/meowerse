import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cat3D } from "./Cat3D";

const mount = vi.hoisted(() => vi.fn());
vi.mock("./renderer", () => ({ mount }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); mount.mockReset(); });

const okFetch = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });

/** Motion allowed; IntersectionObserver / ResizeObserver whose callbacks the test fires by hand. */
function lazyEnv(fetchImpl: (url: string, init?: RequestInit) => Promise<unknown> = okFetch) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  const fetch = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetch);
  let fire: (visible: boolean) => void = () => {};
  const io = { disconnect: vi.fn() };
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) { fire = (visible) => cb([{ isIntersecting: visible }]); }
    observe() {}
    disconnect() { io.disconnect(); }
  });
  let resize: () => void = () => {};
  const ro = { disconnect: vi.fn() };
  vi.stubGlobal("ResizeObserver", class {
    constructor(cb: () => void) { resize = cb; }
    observe() {}
    disconnect() { ro.disconnect(); }
  });
  return {
    fetch, io, ro,
    visible: (v = true) => act(async () => { fire(v); await new Promise((r) => setTimeout(r, 0)); }),
    resize: () => resize(),
  };
}
const api = () => ({ setAim: vi.fn(), destroy: vi.fn(), kick: vi.fn() });
const move = () => dispatchEvent(new MouseEvent("pointermove", { clientX: innerWidth / 2, clientY: innerHeight / 2 }));

describe("Cat3D", () => {
  it("is decorative, renders the poster first, and sizes through the img (no inline style)", () => {
    const { container } = render(<Cat3D size={120} />);
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root).not.toHaveAttribute("style");
    const img = root.querySelector("img");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("width", "120");
    expect(img).toHaveAttribute("height", "120");
  });
  it("stays on the poster when motion is reduced (never loads the renderer)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const io = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { constructor() { io(); } observe() {} disconnect() {} });
    const { container } = render(<Cat3D />);
    expect(io).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toHaveAttribute("hidden");
  });
  it("mounts once visible, kicks the first frame and on resize, aims only while in view, destroys on unmount", async () => {
    const a = api();
    mount.mockReturnValue(a);
    const env = lazyEnv();
    const { container, unmount } = render(<Cat3D className="x" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("mw-cat3d", "x");
    await env.visible();
    expect(env.fetch).toHaveBeenCalledWith("cat.bin", { signal: expect.any(AbortSignal) });
    expect(mount).toHaveBeenCalledWith(root.querySelector("canvas"), expect.any(ArrayBuffer), { color: "#14995a", light: "#63d396" });
    expect(root.querySelector("canvas")).not.toHaveAttribute("hidden");
    expect(root).toHaveClass("mw-cat3d--live"); // poster hidden by visibility, still sizing the box
    expect(a.kick).toHaveBeenCalledTimes(1); // first frame after the canvas is laid out
    env.resize();
    expect(a.kick).toHaveBeenCalledTimes(2);

    // jsdom's rect is 0×0 at the origin; offsets are normalised by half the viewport, y up
    move();
    expect(a.setAim).toHaveBeenCalledWith(1, -1);
    await env.visible(false);
    move();
    expect(a.setAim).toHaveBeenCalledTimes(1); // out of view: no aiming
    await env.visible(true);
    move();
    expect(a.setAim).toHaveBeenCalledTimes(2); // re-entering re-attaches
    expect(env.fetch).toHaveBeenCalledTimes(1); // loads once

    unmount();
    expect(a.destroy).toHaveBeenCalled();
    expect(env.io.disconnect).toHaveBeenCalled();
    expect(env.ro.disconnect).toHaveBeenCalled();
  });
  it("on context loss falls back to the poster and stops listening", async () => {
    const a = api();
    mount.mockReturnValue(a);
    const env = lazyEnv();
    const { container } = render(<Cat3D />);
    await env.visible();
    act(() => { container.querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost")); });
    expect(container.firstElementChild).not.toHaveClass("mw-cat3d--live");
    expect(container.querySelector("canvas")).toHaveAttribute("hidden");
    expect(env.io.disconnect).toHaveBeenCalled();
    expect(env.ro.disconnect).toHaveBeenCalled();
    move();
    expect(a.setAim).not.toHaveBeenCalled();
  });
  it("keeps the poster when WebGL2 is unavailable, the asset fails, or it is off-screen", async () => {
    mount.mockReturnValue(null);
    let env = lazyEnv();
    let { container, unmount } = render(<Cat3D />);
    await env.visible();
    expect(mount).toHaveBeenCalled();
    expect(container.firstElementChild).not.toHaveClass("mw-cat3d--live");
    expect(env.io.disconnect).toHaveBeenCalled();
    unmount();

    mount.mockClear();
    env = lazyEnv(() => Promise.reject(new Error("offline")));
    ({ container, unmount } = render(<Cat3D />));
    await env.visible();
    expect(mount).not.toHaveBeenCalled();
    expect(container.firstElementChild).not.toHaveClass("mw-cat3d--live");
    unmount();

    env = lazyEnv();
    render(<Cat3D />);
    await env.visible(false);
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it("unmounting while loading aborts the fetch and never mounts", async () => {
    const err = vi.spyOn(console, "error");
    let finish: (v: unknown) => void = () => {};
    let signal: AbortSignal | undefined;
    const env = lazyEnv((_u, init) => { signal = init?.signal ?? undefined; return new Promise((r) => { finish = r; }); });
    const { unmount } = render(<Cat3D />);
    await env.visible();
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }); await new Promise((r) => setTimeout(r, 0)); });
    expect(mount).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
