import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// assetsInlineLimit: 0 keeps fonts external so the strict CSP (which blocks
// data: fonts) still loads them — same reason as auth-web.
export default defineConfig({
  // The canonical host (src/lib/seo.ts SITE; a test keeps the two equal).
  site: "https://meowsenger.alxnko.dev",
  integrations: [react()],
  vite: { build: { assetsInlineLimit: 0 } },
});
