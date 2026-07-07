import { defineConfig } from "vitest/config";

// 90% on src/** (the worker logic). src/types.ts is pure types (compiles to
// nothing) — the one honest exclusion, mirroring workers/api.
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
