import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// meow.alxnko.dev enforces Trusted Types (`require-trusted-types-for 'script'; trusted-types 'none'`):
// any raw-HTML sink in a component throws the moment it renders on the client.
const SINK = /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|document\.write/;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe("Trusted Types: shipped ui code has no raw-HTML sinks", () => {
  const files = walk(__dirname).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  it.each(files.map((f) => [f.slice(__dirname.length + 1), f]))("%s", (_name, f) =>
    expect(readFileSync(f, "utf8")).not.toMatch(SINK));
});
