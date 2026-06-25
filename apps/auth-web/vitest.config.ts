import { defineConfig } from "vitest/config";

// Coverage is scoped to src/lib/** (the typed auth API client) — the only pure
// TS logic here. The .astro pages and React islands are smoke-checked by
// `astro check` + `astro build`, mirroring apps/web's honest 90% gate.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/lib/**"],
    },
  },
});
