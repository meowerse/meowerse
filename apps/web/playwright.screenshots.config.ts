import { defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

// Screenshot baselines only, run locally with `bun run shots` (never `bun run e2e`, never CI —
// runner fonts differ, the same local-only deviation as tokens:drift, B28). testDir/testMatch here
// replace the base config's testIgnore rather than layering on top of it.
export default defineConfig(baseConfig, {
  testDir: "tests/e2e",
  testMatch: "**/screenshots.spec.ts",
  testIgnore: undefined,
});
