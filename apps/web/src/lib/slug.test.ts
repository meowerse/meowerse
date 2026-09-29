import { describe, expect, it } from "vitest";
import { toSlug } from "./slug";

describe("toSlug", () => {
  it.each([["Button", "button"], ["ConfirmDialog", "confirm-dialog"], ["AppHeader", "app-header"], ["Cat3D", "cat3d"], ["ToastProvider", "toast-provider"]])(
    "%s → %s", (name, slug) => expect(toSlug(name)).toBe(slug));
});
