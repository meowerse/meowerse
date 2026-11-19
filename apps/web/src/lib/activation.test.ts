// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { afterActivation } from "./activation";

describe("afterActivation", () => {
  it("runs at once on a normal load", () => {
    const fn = vi.fn();
    afterActivation(fn); // the real `document`
    expect(fn).toHaveBeenCalledOnce();
  });
  it("waits for prerenderingchange while prerendering, then runs exactly once", () => {
    const doc = document.implementation.createHTMLDocument("x");
    Object.defineProperty(doc, "prerendering", { value: true });
    const fn = vi.fn();
    afterActivation(fn, doc);
    expect(fn).not.toHaveBeenCalled();
    doc.dispatchEvent(new Event("prerenderingchange"));
    doc.dispatchEvent(new Event("prerenderingchange"));
    expect(fn).toHaveBeenCalledOnce();
  });
});
