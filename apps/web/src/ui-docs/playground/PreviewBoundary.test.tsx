// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewBoundary } from "./PreviewBoundary";

// React's `act` warns unless the environment says it's a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Boom({ text }: { text: string }) {
  if (text === "throw") throw new Error("Cannot read properties of undefined (reading 'trim')");
  return <span className="ok">{text}</span>;
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(console, "error").mockImplementation(() => {});   // React reports every caught error
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const show = (key: string, text: string) => act(() => root.render(
  <div><label>control<input /></label><PreviewBoundary resetKey={key}><Boom text={text} /></PreviewBoundary></div>));

describe("PreviewBoundary", () => {
  it("contains a throwing preview: an inline [fail] line with the message, and everything outside it stays mounted", () => {
    show("a", "throw");
    const line = host.querySelector(".mw-status--fail")!;
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.textContent).toContain("this combination of props can't render");
    expect(line.querySelector("code")!.textContent).toBe("Cannot read properties of undefined (reading 'trim')");
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelector(".ok")).toBeNull();
  });
  it("recovers by itself once the state changes to something that renders", () => {
    show("a", "throw");
    show("b", "fine");
    expect(host.querySelector(".mw-status--fail")).toBeNull();
    expect(host.querySelector(".ok")!.textContent).toBe("fine");
  });
  it("keeps showing the error (updated in place, not re-inserted) while the state still throws", () => {
    show("a", "throw");
    const line = host.querySelector(".mw-status--fail");
    show("b", "throw");
    expect(host.querySelector(".mw-status--fail")).toBe(line);
  });
  it("doesn't remount a working preview when the state changes", () => {
    show("a", "one");
    const el = host.querySelector(".ok");
    show("b", "two");
    expect(host.querySelector(".ok")).toBe(el);
    expect(el!.textContent).toBe("two");
  });
  it("a non-Error throw still shows a message", () => {
    function Str(): never { throw "plain string"; }
    act(() => root.render(<PreviewBoundary resetKey="a"><Str /></PreviewBoundary>));
    expect(host.querySelector("code")!.textContent).toBe("plain string");
  });
});
