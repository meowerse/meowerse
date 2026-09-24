import { describe, expect, it } from "vitest";
import { isCurrent, isExternal, linkAttrs, NAV, SITE } from "./site";

describe("site", () => {
  it("canonical host and theme colours come from the tokens", () => {
    expect(SITE.url).toBe("https://meow.alxnko.dev/");
    expect(SITE.themeColor).toEqual({ dark: "#0a0a0b", light: "#e9e8e4" });
  });
  it("only other origins open in a new tab; mailto and same-site never do", () => {
    expect(linkAttrs("https://github.com/meowerse/meowerse")).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(linkAttrs("/ui/")).toEqual({});
    expect(linkAttrs("https://meow.alxnko.dev/p/auth/")).toEqual({});
    expect(linkAttrs("mailto:x@example.com")).toEqual({});
    expect(isExternal("https://alxnko.dev/")).toBe(true);
  });
  // C3 (pre-flight ruling): /ui/ doesn't exist yet — T7 adds it and its NAV entry. isCurrent stays
  // generic so it needs no change when that entry returns.
  it("marks the nav entry for the current section", () => {
    expect(NAV.map((l) => l.label)).toEqual(["projects"]);
    expect(isCurrent("/p/auth/", "/p/")).toBe(true);
    expect(isCurrent("/ui/components/button/", "/ui/")).toBe(true);
    expect(isCurrent("/", "/ui/")).toBe(false);
  });
});
