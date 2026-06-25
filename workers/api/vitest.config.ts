import { defineConfig } from "vitest/config";

// Coverage is scoped to src/** (the worker logic). The only honest exclusion is
// src/types.ts, which holds pure type/interface declarations (Env, Meow,
// DbClient) that compile away to nothing at runtime — there is no executable
// code to cover, so including it would understate real logic coverage. Every
// file with branches (router, cors, auth, handlers, batch, cache) is held to
// the 90% bar.
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
