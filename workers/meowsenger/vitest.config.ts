import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

// Fast node-pool unit tests for src/** (no workerd). The Conversation Durable
// Object runs in the separate workers project (vitest.workers.config.ts) — its
// *.workers.test.ts files and src/conversation.ts are excluded here.
// 90% on src/**. src/types.ts is pure types (compiles to nothing) and
// src/conversation.ts is covered by the workers project — the two honest
// coverage exclusions, mirroring workers/api.
export default defineConfig({
  // The router tests import src/index.ts, which re-exports the DO from
  // src/conversation.ts — and that file imports the workerd-only
  // `cloudflare:workers` module. In the node pool that module doesn't exist, so
  // alias it to a tiny stub (the DO's real behavior runs in the workers pool).
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers-stub.ts", import.meta.url)),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "src/**/*.workers.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/**"],
      exclude: ["src/types.ts", "src/conversation.ts"],
    },
  },
});
