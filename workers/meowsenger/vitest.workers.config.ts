import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// DO/integration tests run inside workerd (real SQLite + WebSocket). Separate
// from the fast node-pool unit tests (vitest.config.ts).
//
// NOTE: `@cloudflare/vitest-pool-workers` >= 0.13 (the line compatible with the
// repo's pinned vitest ^4.1.9) dropped the old `defineWorkersConfig` helper and
// the `./config` subpath. The current API registers the pool via the
// `cloudflareTest()` Vite plugin instead — same intent, same `wrangler.configPath`.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["src/**/*.workers.test.ts"],
    testTimeout: 40000,
  },
});
