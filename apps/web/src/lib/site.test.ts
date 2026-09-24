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
  // C3 (pre-flight ruling): T7 restores the /ui/ NAV entry now that the page exists. isCurrent stays
  // generic, so no /ui/-specific assertion was needed here even before this entry existed.
  it("marks the nav entry for the current section", () => {
    expect(NAV.map((l) => l.label)).toEqual(["projects", "ui docs"]);
    expect(isCurrent("/p/auth/", "/p/")).toBe(true);
    expect(isCurrent("/ui/components/button/", "/ui/")).toBe(true);
    expect(isCurrent("/", "/ui/")).toBe(false);
  });
});
