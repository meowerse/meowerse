import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cat3D } from "./Cat3D";

const mount = vi.hoisted(() => vi.fn());
vi.mock("./renderer", () => ({ mount }));

afterEach(() => { vi.unstubAllGlobals(); mount.mockReset(); });

/** Motion allowed; IntersectionObserver whose callback the test fires by hand. */
function lazyEnv(fetchImpl: () => Promise<unknown> = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  const fetch = vi.fn(fetchImpl);
  vi.stubGlobal("fetch", fetch);
  let fire: (visible: boolean) => Promise<void> = async () => {};
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: (e: { isIntersecting: boolean }[]) => Promise<void>) { fire = (visible) => cb([{ isIntersecting: visible }]); }
    observe() {}
    disconnect() {}
  });
  return { fetch, visible: (v = true) => act(() => fire(v)) };
}

describe("Cat3D", () => {
  it("is decorative and renders the poster first", () => {
    const { container } = render(<Cat3D />);
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root.querySelector("img")).toHaveAttribute("alt", "");
  });
  it("stays on the poster when motion is reduced (never loads the renderer)", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const io = vi.fn();
    vi.stubGlobal("IntersectionObserver", class { constructor() { io(); } observe() {} disconnect() {} });
    const { container } = render(<Cat3D />);
    expect(io).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toHaveAttribute("hidden");
  });
  it("mounts the renderer once visible, aims at the pointer, falls back on context loss, destroys on unmount", async () => {
    const api = { setAim: vi.fn(), destroy: vi.fn() };
    mount.mockReturnValue(api);
    const env = lazyEnv();
    const { container, unmount } = render(<Cat3D size={120} className="x" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("mw-cat3d", "x");
    await env.visible();
    expect(env.fetch).toHaveBeenCalledWith("cat.bin");
    expect(mount).toHaveBeenCalledWith(root.querySelector("canvas"), expect.any(ArrayBuffer), { color: "#14995a", light: "#63d396" });
    expect(root.querySelector("canvas")).not.toHaveAttribute("hidden");
    expect(root.querySelector("img")).toHaveAttribute("hidden");

    // jsdom's rect is 0×0 at the origin; offsets are normalised by half the viewport, y up
    dispatchEvent(new MouseEvent("pointermove", { clientX: innerWidth / 2, clientY: innerHeight / 2 }) as PointerEvent);
    expect(api.setAim).toHaveBeenCalledWith(1, -1);

    act(() => { root.querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost")); });
    expect(root.querySelector("img")).not.toHaveAttribute("hidden");
    unmount();
    expect(api.destroy).toHaveBeenCalled();
  });
  it("keeps the poster when WebGL2 is unavailable, the asset fails, or it is off-screen", async () => {
    mount.mockReturnValue(null);
    let env = lazyEnv();
    let { container, unmount } = render(<Cat3D />);
    await env.visible();
    expect(mount).toHaveBeenCalled();
    expect(container.querySelector("img")).not.toHaveAttribute("hidden");
    unmount();

    mount.mockClear();
    env = lazyEnv(() => Promise.reject(new Error("offline")));
    ({ container, unmount } = render(<Cat3D />));
    await env.visible();
    expect(mount).not.toHaveBeenCalled();
    expect(container.querySelector("img")).not.toHaveAttribute("hidden");
    unmount();

    env = lazyEnv();
    ({ container } = render(<Cat3D />));
    await env.visible(false);
    expect(env.fetch).not.toHaveBeenCalled();
  });
});
