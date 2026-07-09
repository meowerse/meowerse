/** @vitest-environment happy-dom */
/**
 * Unit tests for the pure message-text helpers: the day-separator label (fmtDay)
 * and the XSS-safe URL linkifier (renderBody). renderBody returns React nodes, so
 * we render them into a container and assert on the produced DOM.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { fmtDay, renderBody } from "./messageText";

afterEach(() => cleanup());

describe("fmtDay", () => {
  it("labels the current calendar day 'today'", () => {
    const d = new Date();
    d.setHours(9, 30, 0, 0);
    expect(fmtDay(d.getTime())).toBe("today");
  });

  it("labels the previous calendar day 'yesterday'", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(9, 30, 0, 0);
    expect(fmtDay(d.getTime())).toBe("yesterday");
  });

  it("labels older days with a short month/day date", () => {
    const d = new Date(2020, 0, 15, 12, 0, 0); // 15 Jan 2020, local
    expect(fmtDay(d.getTime())).toBe(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });
});

describe("renderBody — linkify", () => {
  function renderText(text: string): HTMLElement {
    const { container } = render(<div>{renderBody(text)}</div>);
    return container.firstChild as HTMLElement;
  }

  it("leaves plain text untouched (no anchors)", () => {
    const el = renderText("just a plain message");
    expect(el.querySelectorAll("a").length).toBe(0);
    expect(el.textContent).toBe("just a plain message");
  });

  it("turns an https URL into a safe external anchor", () => {
    const el = renderText("look at https://example.com/page now");
    const a = el.querySelector("a")!;
    expect(a).toBeTruthy();
    expect(a.getAttribute("href")).toBe("https://example.com/page");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toBe("https://example.com/page");
    // The surrounding words survive as text.
    expect(el.textContent).toBe("look at https://example.com/page now");
  });

  it("keeps trailing sentence punctuation OUT of the href", () => {
    const el = renderText("see https://example.com.");
    const a = el.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com");
    expect(a.textContent).toBe("https://example.com");
    // The period is preserved as trailing text.
    expect(el.textContent).toBe("see https://example.com.");
  });

  it("prefixes a bare www. link with https://", () => {
    const el = renderText("visit www.example.com today");
    const a = el.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://www.example.com");
    expect(a.textContent).toBe("www.example.com");
  });

  it("linkifies multiple URLs in one message", () => {
    const el = renderText("a https://one.com b http://two.org c");
    const links = el.querySelectorAll("a");
    expect(links.length).toBe(2);
    expect(links[0].getAttribute("href")).toBe("https://one.com");
    expect(links[1].getAttribute("href")).toBe("http://two.org");
  });

  it("does NOT linkify a javascript: scheme (XSS-safe)", () => {
    const el = renderText("javascript:alert(1)");
    expect(el.querySelectorAll("a").length).toBe(0);
    expect(el.textContent).toBe("javascript:alert(1)");
  });
});
