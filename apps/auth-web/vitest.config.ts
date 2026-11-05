import { getViteConfig } from "astro/config";
import type { ViteUserConfig } from "vitest/config";

// Coverage is scoped to src/lib/** (the typed auth API client) — the only pure
// TS logic here. The .astro pages and React islands are smoke-checked by
// `astro check` + `astro build`, mirroring apps/web's honest 90% gate.
// getViteConfig lets vitest import .astro files (src/lib/prefetch-render.test.ts renders real pages).
// getViteConfig is typed for plain Vite config; vitest's `test` key is accepted at runtime.
export default getViteConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
      include: ["src/lib/**"],
    },
  },
} satisfies ViteUserConfig as never);
