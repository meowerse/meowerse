import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

// DO/integration tests run inside workerd (real SQLite + WebSocket). Separate
// from the fast node-pool unit tests (vitest.config.ts).
//
// NOTE: `@cloudflare/vitest-plugin` replaces the deprecated
// `@cloudflare/vitest-pool-workers`; the workers pool is registered via the
// `cloudflareTest()` Vite plugin with the same `wrangler.configPath`.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["src/**/*.workers.test.ts"],
    testTimeout: 40000,
  },
});
