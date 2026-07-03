import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// assetsInlineLimit: 0 keeps ALL fonts as external same-origin files instead of
// inlining small ones as data: URIs — the CSP (default-src 'self', no font-src)
// blocks data: fonts, which silently dropped Bytesized to a fallback on the
// deployed site. External woff2 are also cacheable + smaller (no base64 bloat).
export default defineConfig({
  integrations: [react()],
  vite: { build: { assetsInlineLimit: 0 } },
});
