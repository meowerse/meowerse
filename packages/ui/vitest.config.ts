import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    css: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/index.ts", "src/styles/**", "src/**/*.test.{ts,tsx}",
        // WebGL2 has no jsdom implementation; scripts/cat-poster.ts verifies it end to end in Chromium (real GPU).
        "src/cat3d/renderer.ts",
      ],
      thresholds: { branches: 90, functions: 90, lines: 90, statements: 90 },
    },
  },
});
