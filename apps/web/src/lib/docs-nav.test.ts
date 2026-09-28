import { describe, expect, it } from "vitest";
import { docsNav } from "./docs-nav";

describe("docsNav", () => {
  it("starts with the overview and the foundations, and every link is a /ui/ path with a trailing slash", () => {
    const groups = docsNav(["Button", "Alert"]);
    expect(groups[0]).toEqual({ label: "start", items: [{ label: "overview", href: "/ui/" }] });
    expect(groups.find((g) => g.label === "foundations")!.items.map((i) => i.label)).toEqual(["colours", "type", "space, radii, layers", "motion", "voice"]);
    for (const g of groups) for (const i of g.items) expect(i.href).toMatch(/^\/ui\/([a-z0-9-]+\/)*$/);
  });
  it("has the patterns, then ends with the playground, the gallery, cat3d and utilities", () => {
    const groups = docsNav([]);
    expect(groups.find((g) => g.label === "patterns")!.items.map((i) => i.href)).toEqual([
      "/ui/patterns/together/", "/ui/patterns/forms/", "/ui/patterns/states/", "/ui/patterns/composer/",
    ]);
    expect(groups.at(-1)!.items.map((i) => i.href)).toEqual(["/ui/playground/", "/ui/gallery/", "/ui/cat3d/", "/ui/utilities/"]);
  });
  it("lists every component under components, after an index link", () => {
    const comps = docsNav(["Button", "ConfirmDialog", "Alert"]).find((g) => g.label === "components")!;
    expect(comps.items).toEqual([
      { label: "all components", href: "/ui/components/" },
      { label: "Alert", href: "/ui/components/alert/" },
      { label: "Button", href: "/ui/components/button/" },
      { label: "ConfirmDialog", href: "/ui/components/confirm-dialog/" },
    ]);
  });
});
