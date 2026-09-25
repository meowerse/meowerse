import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { extractUiApi, uiDirFrom } from "../lib/ui-api";
import { toSlug } from "../lib/slug";
import { COMPONENT_PAGES, nodeOf } from "./registry";

const api = extractUiApi(uiDirFrom(process.cwd()));

describe("component docs registry", () => {
  it("documents every exported component and nothing else (a new ui component without docs fails here)", () =>
    expect(COMPONENT_PAGES.map((p) => p.name)).toEqual(api.components.map((c) => c.name)));
  it.each(COMPONENT_PAGES.map((p) => [p.name, p] as const))("%s has a summary, examples, a11y notes and do/don't", (_n, p) => {
    expect(p.slug).toBe(toSlug(p.name));
    expect(p.summary.length).toBeGreaterThan(20);
    if (!p.interactiveOnly) expect(p.examples.length).toBeGreaterThan(0);
    expect(p.a11y.length).toBeGreaterThan(0);
    expect(p.dos.length).toBeGreaterThan(0);
    expect(p.donts.length).toBeGreaterThan(0);
  });
  it.each(COMPONENT_PAGES.flatMap((p) => p.examples.map((e) => [`${p.name}: ${e.title}`, e] as const)))("%s renders on the server", (_n, e) => {
    expect(renderToStaticMarkup(nodeOf(e, "page"))).toMatch(/^</);
  });
});
