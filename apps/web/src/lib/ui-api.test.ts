import { describe, expect, it } from "vitest";
import { extractUiApi, uiDirFrom } from "./ui-api";

const api = extractUiApi(uiDirFrom(process.cwd()));
const comp = (n: string) => api.components.find((c) => c.name === n)!;
const prop = (c: string, p: string) => comp(c).props.find((x) => x.name === p)!;

describe("extractUiApi (TypeScript compiler API over @meowerse/ui)", () => {
  it("finds every exported component, the cat included", () =>
    expect(api.components.map((c) => c.name)).toEqual([
      "Alert", "AppHeader", "AuthGate", "Avatar", "Badge", "Button", "Card", "Cat3D", "Checkbox", "Code",
      "ConfirmDialog", "ContactLinks", "Cursor", "Field", "Footer", "Icon", "Kbd", "Modal", "Prompt",
      "RadioGroup", "RecoveryCodes", "Spinner", "StatusLine", "ThemeToggle", "ToastProvider", "Wordmark",
    ]));
  it("reads a forwardRef component's own props, values and destructuring defaults", () => {
    expect(prop("Button", "variant")).toMatchObject({ type: '"primary" | "secondary" | "ghost" | "danger"', required: false, default: '"secondary"' });
    expect([...prop("Button", "variant").values!].sort()).toEqual(["danger", "ghost", "primary", "secondary"]);
    expect(prop("Button", "size")).toMatchObject({ default: '"md"', required: false });
    expect(prop("Button", "loading")).toMatchObject({ type: "boolean", default: "false" });
    expect(prop("Button", "loading").values).toBeUndefined();
    expect(comp("Button").inherits).toEqual(expect.arrayContaining(["ButtonHTMLAttributes", "RefAttributes"]));
  });
  it("reads a function component's props, required-ness and alias values", () => {
    expect(prop("Alert", "children")).toMatchObject({ type: "ReactNode", required: true });
    expect(prop("Alert", "variant").default).toBe('"info"');
    expect(prop("Alert", "onDismiss")).toMatchObject({ type: "() => void", required: false });
    expect(prop("StatusLine", "state")).toMatchObject({ type: "StatusState", required: true });
    expect([...prop("StatusLine", "state").values!].sort()).toEqual(["fail", "info", "ok", "wait"]);
    expect(prop("Cat3D", "size").default).toBe("160");
  });
  it("keeps an inherited prop the component gives a default", () =>
    expect(prop("Field", "type")).toMatchObject({ default: '"text"', inherited: true }));
  it("lists functions with signatures and constants with types", () => {
    const fns = api.functions.map((f) => f.name);
    for (const n of ["request", "useSession", "toggleTheme", "cx", "contrast", "attachCat3D", "useToast"]) expect(fns).toContain(n);
    expect(api.functions.find((f) => f.name === "cx")!.signature).toMatch(/^\(\.\.\.parts: /);
    expect(api.values.map((v) => v.name)).toEqual(expect.arrayContaining(["THEME_INIT_SCRIPT", "DEFAULT_TIMEOUT_MS", "ICON_NAMES", "CONTRAST_PAIRS"]));
    expect(api.types).toEqual(expect.arrayContaining(["ButtonProps", "Session", "StatusState"]));
  });
  it("records where each export lives", () => expect(comp("Prompt").file).toBe("src/components/Prompt.tsx"));
  it("fails loudly when the source isn't there", () => {
    expect(() => uiDirFrom("/nonexistent")).toThrow(/@meowerse\/ui source not found/);
    expect(() => extractUiApi(uiDirFrom(process.cwd()), ["src/nope.ts"])).toThrow(/can't read src\/nope.ts/);
  });
});
