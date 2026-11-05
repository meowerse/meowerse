import { experimental_AstroContainer as AstroContainer } from "astro/container";
import reactRenderer from "@astrojs/react/server.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader } from "@meowerse/ui";
import { beforeAll, describe, expect, it } from "vitest";
import Index from "../pages/index.astro";
import NotFound from "../pages/404.astro";
import About from "../pages/about.astro";
import Privacy from "../pages/privacy.astro";
import Docs from "../pages/docs.astro";
import Login from "../pages/login.astro";
import Developers from "../pages/developers.astro";
import DevMarketing from "../components/DevMarketing";
import { isPrefetchable } from "./prefetch";

// Renders the REAL pages (Layout + AppHeader + Footer) with Astro's Container API, so this needs no dist/.
const pages = { "/": Index, "/404": NotFound, "/about/": About, "/privacy/": Privacy, "/docs/": Docs, "/login/": Login, "/developers/": Developers };
const html: Record<string, string> = {};

beforeAll(async () => {
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/react", renderer: reactRenderer });
  container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
  for (const [path, page] of Object.entries(pages)) html[path] = await container.renderToString(page);
}, 60_000);

const anchorsOf = (h: string) => [...h.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
const hrefOf = (a: string) => /\bhref="([^"]*)"/.exec(a)?.[1]?.replaceAll("&#38;", "&").replaceAll("&amp;", "&");
const marked = (a: string) => /\bdata-astro-prefetch="hover"/.test(a);
const FORBIDDEN = ["login", "signup", "consent", "verify", "account", "dashboard", "error", "developers"];

describe("rendered pages: data-astro-prefetch", () => {
  it("renders every page with anchors", () => {
    for (const [p, h] of Object.entries(html)) expect(anchorsOf(h).length, p).toBeGreaterThan(3);
  });

  it("every marked link points at an allowlisted path; no forbidden or cross-origin link is marked", () => {
    for (const [p, h] of Object.entries(html)) {
      for (const a of anchorsOf(h)) {
        const href = hrefOf(a) ?? "";
        if (marked(a)) expect(isPrefetchable(href), `${p}: ${a}`).toBe(true);
        const path = href.split(/[?#]/)[0]?.replace(/\/$/, "");
        if (FORBIDDEN.some((f) => path === `/${f}`) || /^(https?:)?\/\//.test(href) || href.startsWith("mailto:")) expect(marked(a), `${p}: ${a}`).toBe(false);
      }
    }
  });

  it("the six expected links carry it (brand, header about/docs, footer about/privacy/terms) on the home page", () => {
    const marks = anchorsOf(html["/"] ?? "").filter(marked).map((a) => hrefOf(a));
    expect(marks).toEqual(expect.arrayContaining(["/", "/about/", "/docs/", "/privacy/", "/terms/"]));
    expect(marks.filter((h) => h === "/about/")).toHaveLength(2); // header + footer
    expect(marks).toHaveLength(6);
  });

  it("the 404 back-home link carries it", () => {
    expect(html["/404"]).toMatch(/<a href="\/" data-astro-prefetch="hover">back home<\/a>/);
  });

  it("DevMarketing: /docs is marked, /login is not", async () => {
    const container = await AstroContainer.create();
    container.addServerRenderer({ name: "@astrojs/react", renderer: reactRenderer });
    const out = await container.renderToString(DevMarketing as never);
    const as = anchorsOf(out);
    expect(as.filter(marked).map(hrefOf)).toEqual(["/docs/"]);
    expect(as.some((a) => hrefOf(a)?.startsWith("/login") && marked(a))).toBe(false);
  });

  // SSR renders the header in its loading state, so the login/signup/account links only exist after hydration:
  // render the real AppHeader in each settled session state with the production predicate.
  it("settled header states: login/signup/account/developers never marked; allowlisted ones are", () => {
    for (const session of [{ loading: false as const, authenticated: false as const }, { loading: false as const, authenticated: true as const, username: "alex", verified: true }]) {
      const as = anchorsOf(renderToStaticMarkup(createElement(AppHeader, { session, prefetch: isPrefetchable })));
      expect(as.length).toBeGreaterThan(3);
      for (const a of as) {
        const href = hrefOf(a) ?? "";
        expect(marked(a), a).toBe(isPrefetchable(href));
        if (FORBIDDEN.includes(href.split(/[?#]/)[0]?.replace(/\/$/, "").slice(1) ?? "")) expect(marked(a), a).toBe(false);
      }
    }
  });
});
