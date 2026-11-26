import { defineConfig } from "@playwright/test";

// e2e against a dedicated build (dist-e2e, with a Turnstile site key so the widget renders; the test stubs the
// Turnstile script) served with the real _headers (CSP included). `bun run e2e` builds then runs.
const PORT = process.env.E2E_PORT ?? "4381";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, browserName: "chromium" },
  webServer: { command: `bun scripts/serve-dist.ts ${PORT} dist-e2e`, url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false },
});
