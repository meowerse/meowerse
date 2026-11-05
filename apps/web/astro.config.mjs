import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// Static site under a strict hash-based CSP (scripts/postbuild.ts):
// - inlineStylesheets "always": the one site stylesheet (src/styles/site.css, imported only by
//   BaseLayout) is inlined on every page, so there is one CSP hash and no render-blocking CSS (B26);
// - assetsInlineLimit 0: fonts, the cat mesh and every other asset stay same-origin files. No data:
//   URLs, which img-src/font-src 'self' would block (SP1 deferral).
export default defineConfig({
  site: "https://meow.alxnko.dev",
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  // Hover prefetch of same-origin links only (Astro's canPrefetchUrl, astro/dist/prefetch/index.js, rejects other origins and
  // skips Save-Data / 2g connections for non-"tap" strategies). Every route is static and side-effect free.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  build: { inlineStylesheets: "always", format: "directory" },
  vite: { build: { assetsInlineLimit: 0 } },
  devToolbar: { enabled: false },
  server: { host: "127.0.0.1", port: 4370 },
});
