// Build-time docs data for the /ui pages. One TypeScript program per build (memoised).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssApiFor, type CssApi } from "../lib/css-api";
import { extractUiApi, uiDirFrom, type ComponentDoc, type UiApi } from "../lib/ui-api";

export const UI_DIR = uiDirFrom(process.cwd());
let cached: UiApi | undefined;

export function uiApi(): UiApi {
  return (cached ??= extractUiApi(UI_DIR));
}

export function componentDoc(name: string): ComponentDoc {
  const d = uiApi().components.find((c) => c.name === name);
  if (!d) throw new Error(`@meowerse/ui exports no component named ${name}`);
  return d;
}

const style = (f: string) => readFileSync(join(UI_DIR, "src/styles", f), "utf8");

export function cssApi(name: string): CssApi {
  const source = readFileSync(join(UI_DIR, componentDoc(name).file), "utf8");
  return cssApiFor(source, style("components.css"), style("tokens.gen.css"), style("aliases.css"));
}
