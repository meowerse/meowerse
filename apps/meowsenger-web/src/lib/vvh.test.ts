// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackVisualViewport } from "./vvh";

function fakeVv(o: { height: number; scale: number; offsetTop?: number }) {
  const l: Record<string, () => void> = {};
  const vv = { ...o, offsetTop: o.offsetTop ?? 0, addEventListener: (t: string, f: () => void) => { l[t] = f; } };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return { vv, l };
}

describe("trackVisualViewport", () => {
  afterEach(() => { document.documentElement.style.removeProperty("--vvh"); vi.restoreAllMocks(); });

  it("sets --vvh from the visual viewport and follows resize", () => {
    const { vv, l } = fakeVv({ height: 500, scale: 1 });
    trackVisualViewport();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("500px");
    vv.height = 300; l.resize!();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("300px");
  });

  it("pinch-zoom (scale>1) does not shrink the shell", () => {
    fakeVv({ height: 400, scale: 2 });
    trackVisualViewport();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("800px");
  });

  it("only resets layout scroll when not zoomed", () => {
    const sc = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const a = fakeVv({ height: 500, scale: 1, offsetTop: 40 });
    trackVisualViewport(); a.l.scroll!();
    expect(sc).toHaveBeenCalledTimes(1);
    const b = fakeVv({ height: 500, scale: 2, offsetTop: 40 });
    trackVisualViewport(); b.l.scroll!();
    expect(sc).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without visualViewport", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    trackVisualViewport();
    expect(document.documentElement.style.getPropertyValue("--vvh")).toBe("");
  });
});
