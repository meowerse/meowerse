// The public API of @meowerse/ui, read at build time with the TypeScript compiler API, so the docs'
// props tables can't drift from the source (spec §5.2). A pure function of the source files.
import ts from "typescript";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

export type PropDoc = {
  name: string; type: string; values?: string[]; required: boolean; default?: string; description?: string; inherited?: boolean;
};
export type ComponentDoc = { name: string; file: string; description?: string; props: PropDoc[]; inherits: string[] };
export type FunctionDoc = { name: string; file: string; signature: string; description?: string };
export type ValueDoc = { name: string; file: string; type: string; description?: string };
export type UiApi = { components: ComponentDoc[]; functions: FunctionDoc[]; values: ValueDoc[]; types: string[] };

const FMT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** packages/ui, found from the web app's directory (the build and the tests run in apps/web). */
export function uiDirFrom(cwd: string): string {
  const dir = join(cwd, "../../packages/ui");
  if (!existsSync(join(dir, "src/index.ts"))) throw new Error(`@meowerse/ui source not found at ${dir}`);
  return dir;
}

/** The function whose first parameter carries the props: the declaration itself, or the first function
 *  inside it, e.g. forwardRef(function X(…) {}) or const X = (…) => …. */
function fnOf(decl: ts.Node): ts.SignatureDeclaration | undefined {
  return ts.isFunctionLike(decl) ? decl : ts.forEachChild(decl, fnOf);
}

function defaultsOf(decl: ts.Node): Record<string, string> {
  const out: Record<string, string> = {};
  const p = fnOf(decl)?.parameters[0]?.name;
  if (p && ts.isObjectBindingPattern(p))
    for (const el of p.elements) if (el.initializer) out[(el.propertyName ?? el.name).getText()] = el.initializer.getText();
  return out;
}

export function extractUiApi(uiDir: string, entries = ["src/index.ts", "src/cat3d/index.ts"]): UiApi {
  // Checked before the (slow) program is built, so a wrong entry fails fast and by name.
  for (const e of entries) if (!existsSync(join(uiDir, e))) throw new Error(`can't read ${e}`);
  const roots = [...entries.map((e) => join(uiDir, e)), join(uiDir, "src/assets.d.ts")];
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, strict: true, skipLibCheck: true, noEmit: true, resolveJsonModule: true, types: [],
  });
  const checker = program.getTypeChecker();
  const src = join(uiDir, "src");
  const own = (d: ts.Node) => { const f = d.getSourceFile().fileName; return f.startsWith(src) && !f.includes("/node_modules/"); };
  const doc = (s: ts.Symbol) => ts.displayPartsToString(s.getDocumentationComment(checker)).trim() || undefined;
  const out: UiApi = { components: [], functions: [], values: [], types: [] };
  const seen = new Set<string>();

  for (const entry of entries) {
    const sf = program.getSourceFile(join(uiDir, entry))!; // exists: checked above
    const mod = checker.getSymbolAtLocation(sf);
    if (!mod) throw new Error(`${entry} has no exports`);
    for (const exp of checker.getExportsOfModule(mod)) {
      const name = exp.getName();
      if (seen.has(name)) continue;
      seen.add(name);
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      if (!(sym.flags & ts.SymbolFlags.Value)) { out.types.push(name); continue; }
      const decl = sym.valueDeclaration!; // every value symbol declared in source has one
      const file = relative(uiDir, decl.getSourceFile().fileName);
      const type = checker.getTypeOfSymbolAtLocation(sym, decl);
      const call = type.getCallSignatures()[0];
      if (!call) { out.values.push({ name, file, type: checker.typeToString(type, undefined, FMT), description: doc(sym) }); continue; }
      if (!/^[A-Z]/.test(name)) {
        out.functions.push({ name, file, signature: checker.signatureToString(call, undefined, FMT), description: doc(sym) });
        continue;
      }
      const param = call.getParameters()[0];
      const propsType = param ? checker.getTypeOfSymbol(param) : undefined;
      const defaults = defaultsOf(decl);
      const props: PropDoc[] = [];
      const inherits = new Set<string>();
      for (const p of propsType ? checker.getPropertiesOfType(propsType) : []) {
        const pd = p.declarations?.[0];
        if (!pd) continue;
        const pname = p.getName();
        const t = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, pd));
        const values = t.isUnion() && t.types.every((u) => u.isStringLiteral())
          ? t.types.map((u) => (u as ts.StringLiteralType).value) : undefined;
        const required = !(p.flags & ts.SymbolFlags.Optional);
        if (!own(pd)) {
          if (ts.isInterfaceDeclaration(pd.parent)) inherits.add(pd.parent.name.text);
          if (defaults[pname] !== undefined)
            props.push({ name: pname, type: checker.typeToString(t, undefined, FMT), values, required, default: defaults[pname], inherited: true });
          continue;
        }
        const typeNode = ts.isPropertySignature(pd) ? pd.type : undefined;
        props.push({
          name: pname, type: typeNode ? typeNode.getText() : checker.typeToString(t, undefined, FMT), values, required,
          default: defaults[pname], description: doc(p),
        });
      }
      out.components.push({ name, file, description: doc(sym), props, inherits: [...inherits].sort() });
    }
  }
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  out.components.sort(byName);
  out.functions.sort(byName);
  out.values.sort(byName);
  out.types.sort();
  return out;
}
