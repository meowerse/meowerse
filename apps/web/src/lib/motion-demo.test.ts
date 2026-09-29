// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bindMotionDemos } from "./motion-demo";

describe("motion demos", () => {
  it("play toggles the demo and names the next action", () => {
    const demo = document.createElement("div");
    demo.setAttribute("data-motion-demo", "");
    const btn = document.createElement("button");
    btn.setAttribute("data-motion-play", "");
    btn.textContent = "play";
    demo.append(btn);
    document.body.replaceChildren(demo);
    bindMotionDemos(document);
    btn.click();
    expect(demo.classList.contains("is-playing")).toBe(true);
    expect(btn.textContent).toBe("reset");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.click();
    expect(demo.classList.contains("is-playing")).toBe(false);
    expect(btn.textContent).toBe("play");
  });
});
