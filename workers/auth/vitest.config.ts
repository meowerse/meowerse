import { defineConfig } from "vitest/config";

// Coverage is scoped to src/** (the worker logic) and held to 90% on every
// metric. The only honest exclusion is src/types.ts — pure type/interface
// declarations (Env, row shapes, DbClient) that compile away to nothing at
// runtime, so there is no executable code to cover.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/**"],
      exclude: ["src/types.ts"],
    },
  },
});
