import { defineConfig } from "@playwright/test";

// e2e against dist/ served with the real _headers (CSP included): run `bun run build` first.
// Phone is 390×844 at DPR 1 (spec audit §5b size; DPR 1 keeps screenshot files small).
export default defineConfig({
  testDir: "tests/e2e",
  // Screenshot baselines are local-only (runner fonts differ in CI, like tokens:drift, B28):
  // `bun run e2e` never picks them up. `bun run shots` (playwright.screenshots.config.ts) does.
  testIgnore: "**/screenshots.spec.ts",
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  snapshotPathTemplate: "tests/e2e/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: "disabled", caret: "hide" } },
  use: {
    baseURL: "http://127.0.0.1:4371",
    colorScheme: "dark",
    trace: "retain-on-failure",
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: "bun scripts/serve-dist.ts 4371",
    url: "http://127.0.0.1:4371/",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
});
