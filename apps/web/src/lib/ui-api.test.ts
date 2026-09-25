import ts from "typescript";
import { describe, expect, it } from "vitest";
import { extractUiApi, fnOf, uiDirFrom } from "./ui-api";

const api = extractUiApi(uiDirFrom(process.cwd()));
const comp = (n: string) => api.components.find((c) => c.name === n)!;
const prop = (c: string, p: string) => comp(c).props.find((x) => x.name === p)!;

/** The declaration `sym.valueDeclaration` would be for a top-level `export const`/`export function`
 *  statement in `src` — enough to drive fnOf() without a full type-checked program. */
function declOf(src: string): ts.Node {
  const sf = ts.createSourceFile("f.tsx", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (!found && (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n))) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return found!;
}

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

  // Narrower inherits (T8a ruling): the docs table should show only the most specific inherited
  // interface, not the whole @types/react ancestor chain, and not forwardRef's own ref/key wrapper.
  describe("primaryInherit narrows the ancestor chain to the one interface worth showing", () => {
    it("Button: the element-specific HTML attributes interface, not the whole chain", () => {
      expect(comp("Button").primaryInherit).toBe("ButtonHTMLAttributes<HTMLButtonElement>");
    });
    it("Field: the input attributes, unwrapped from the Omit<> that drops \"id\"", () => {
      expect(comp("Field").primaryInherit).toBe("InputHTMLAttributes<HTMLInputElement>");
    });
    it("Prompt: undefined — its only \"inherited\" members are forwardRef's ref/key wrapper, which isn't a component prop worth showing", () => {
      expect(comp("Prompt").inherits).toEqual(expect.arrayContaining(["RefAttributes"]));
      expect(comp("Prompt").primaryInherit).toBeUndefined();
    });
  });

  // Every component and every own (non-inherited) prop must carry a description, so the docs tables
  // (whose data comes straight from this extraction) never show a blank description column.
  it("every component and every own prop has a JSDoc description", () => {
    const missing: string[] = [];
    for (const c of api.components) {
      if (!c.description) missing.push(c.name);
      for (const p of c.props) if (!p.inherited && !p.description) missing.push(`${c.name}.${p.name}`);
    }
    expect(missing).toEqual([]);
  });

  // Pin the fnOf assumption (T8a ruling): it's a DFS that returns the FIRST function-like node, so
  // these are the exact declaration shapes the real 26 components use, plus the documented misread.
  describe("fnOf finds the render function inside a declaration (pinned shapes)", () => {
    it("a plain function declaration is itself function-like", () => {
      const decl = declOf("export function Foo(props) { return null; }");
      expect(fnOf(decl)).toBe(decl);
    });
    it("forwardRef(function X(…) {…}) — the named function expression inside the call", () => {
      const decl = declOf("export const Foo = forwardRef(function Foo(props, ref) { return null; });");
      const found = fnOf(decl);
      expect(found && ts.isFunctionExpression(found)).toBe(true);
    });
    it("const X = (…) => … — the arrow function", () => {
      const decl = declOf("export const Foo = (props) => { return null; };");
      const found = fnOf(decl);
      expect(found && ts.isArrowFunction(found)).toBe(true);
    });
    it("takes the FIRST function-like node: a callback placed before the component function is misread", () => {
      const decl = declOf("export const Foo = withLogger(() => {}, function Foo(props) { return null; });");
      const found = fnOf(decl);
      expect(found && ts.isArrowFunction(found)).toBe(true); // the () => {} callback, not "Foo"
    });
  });
});
