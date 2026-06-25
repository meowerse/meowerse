import { defineConfig } from "vitest/config";

// Coverage is scoped to src/lib/** on purpose. That directory holds the only
// pure TS logic in this app (the typed API client). This is the honest
// exclusion for the 90% gate: the .astro pages and the React island
// (src/components/**) are smoke-checked by `astro check` and `astro build`,
// not by the coverage gate, so we do not pad the number with untested UI glue
// or hold thin view code to a unit-test bar it was never meant to meet.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      all: true,
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/lib/**"],
    },
  },
});
