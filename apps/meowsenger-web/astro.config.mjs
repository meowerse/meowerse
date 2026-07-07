import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// assetsInlineLimit: 0 keeps fonts external so the strict CSP (which blocks
// data: fonts) still loads them — same reason as auth-web.
export default defineConfig({
  integrations: [react()],
  vite: { build: { assetsInlineLimit: 0 } },
});
