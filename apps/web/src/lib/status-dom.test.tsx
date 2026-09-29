// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusLine, type StatusState } from "@meowerse/ui";
import { setStatus } from "./status-dom";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body.firstElementChild as HTMLElement;

describe("setStatus keeps a server-rendered StatusLine identical to what StatusLine renders", () => {
  it.each(["ok", "wait", "fail", "info"] as StatusState[])("→ %s", (state) => {
    const el = parse(renderToStaticMarkup(<StatusLine state="wait" live>auth — checking…</StatusLine>));
    setStatus(el, state, "auth — done");
    expect(el.outerHTML).toBe(renderToStaticMarkup(<StatusLine state={state} live>auth — done</StatusLine>));
  });
  it("keeps extra classes after the state class", () => {
    const el = parse(renderToStaticMarkup(<StatusLine state="wait" live className="x">a</StatusLine>));
    setStatus(el, "ok", "b");
    expect(el.className).toBe("mw-status mw-status--ok x");
  });
});
