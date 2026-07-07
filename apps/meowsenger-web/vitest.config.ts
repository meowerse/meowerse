import { defineConfig } from "vitest/config";
// Only src/lib/** (the typed API client) is unit-covered; pages/islands are
// checked by astro check + astro build (honest-90, same as auth-web).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/lib/**"],
    },
  },
});
