import { defineConfig } from "vitest/config";

// Pure logic lives in src/lib/** and carries the 90% gate. Pages, layouts and islands are covered by
// `astro check`, the build (+ scripts/postbuild.ts guards) and the Playwright suite (bun run e2e).
// DOM tests opt into jsdom per file with a `// @vitest-environment jsdom` first line.
export default defineConfig({
  test: {
    // Node >=25 ships a native globalThis.localStorage that is undefined without --localstorage-file and shadows jsdom's; --no-experimental-webstorage restores jsdom's.
    execArgv: process.allowedNodeEnvironmentFlags.has("--no-experimental-webstorage") ? ["--no-experimental-webstorage"] : [],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
      exclude: ["src/lib/**/*.test.{ts,tsx}"],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
