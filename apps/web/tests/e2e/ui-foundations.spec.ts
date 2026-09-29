import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "./fixtures";

test("colours: every semantic token in both themes and every contrast pair passing", async ({ page }) => {
  await page.goto("/ui/foundations/colours/");
  await expect(page.locator('section[aria-labelledby="sem-title"] tbody tr')).toHaveCount(21);
  const rows = page.locator('section[aria-labelledby="contrast-title"] tbody tr');
  await expect(rows).toHaveCount(42);
  await expect(page.locator('section[aria-labelledby="contrast-title"] .mw-status--fail')).toHaveCount(0);
});

test("motion: play moves the dots and says reset", async ({ page }) => {
  await page.goto("/ui/foundations/motion/");
  const play = page.locator("[data-motion-play]");
  await play.click();
  await expect(page.locator("[data-motion-demo]")).toHaveClass(/is-playing/);
  await expect(play).toHaveText("reset");
});

test("copy buttons copy and say so", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "clipboard permissions are desktop-only in this setup");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ui/");
  await page.locator('[data-copy="use"]').click();
  await expect(page.locator('[data-copy="use"]')).toHaveText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('import "@meowerse/ui/tokens.css";');
});

test("utilities are generated from the source", async ({ page }) => {
  await page.goto("/ui/utilities/");
  await expect(page.locator("td code", { hasText: /^request$/ })).toBeVisible();
  await expect(page.locator("td code", { hasText: /^THEME_INIT_SCRIPT$/ })).toBeVisible();
});

test("the docs menu is reachable on phones from the top of the page", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "the jump link only shows on narrow screens");
  await page.goto("/ui/foundations/type/");
  await page.locator(".docs__jump").click();
  await expect(page.locator("#docs-nav")).toBeInViewport();
});

// P29: `ui-docs/api.ts` pulls in the TypeScript compiler so the docs' props/utilities tables can't
// drift from the source (Task 6). That compiler must never reach the browser: this is the build-
// output backstop for src/lib/ui-docs-boundary.test.ts's source scan (which proves it statically,
// from the import graph; this proves it in the actual shipped bytes).
//
// `createProgram` alone isn't distinctive enough — WebGL's `gl.createProgram()`, used by the
// Cat3D renderer chunk, matches it too (a real false positive hit while writing this test). Instead
// this greps for one of the `typescript` package's own diagnostic-message sentences: verbatim text
// from its source that survives minification (string literals aren't renamed) and that no other
// dependency in this build would ever contain.
//
// Fix round 1: a literal string marker like this is silent, not loud, if a `typescript` upgrade
// ever rewords or removes that diagnostic — the assertion below would still pass, but for the
// wrong reason (nothing in the bundle says this text any more, not because the compiler is gone).
// So the self-check test right after this one reads the *installed* `typescript` package's own
// source and asserts the marker still occurs there. If a `typescript` bump changes the wording,
// that self-check fails loudly and says so, instead of this test quietly proving nothing.
const TS_COMPILER_MARKER = "or its corresponding type declarations";

test("no TypeScript compiler code reaches the built client bundle (P29)", async ({}, info) => {
  test.skip(info.project.name !== "desktop", "the file scan runs once");
  const dir = join(process.cwd(), "dist/_astro");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    expect(src, f).not.toContain(TS_COMPILER_MARKER);
  }
});

test("self-check: the marker above is still a real TypeScript-compiler signature (P29)", async ({}, info) => {
  test.skip(info.project.name !== "desktop", "the file scan runs once");
  // Resolves through Node's normal module resolution (finds the hoisted workspace copy), so this
  // reads whatever `typescript` version this build actually used — not a hardcoded path.
  const tsMain = createRequire(import.meta.url).resolve("typescript");
  const tsSource = readFileSync(tsMain, "utf8");
  expect(tsSource, `${TS_COMPILER_MARKER}" not found in ${tsMain} — the P29 marker above is stale; ` +
    "pick a new distinctive string from the installed typescript package and update both tests")
    .toContain(TS_COMPILER_MARKER);
});
