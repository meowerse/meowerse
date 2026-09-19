import { defineAuthClient } from "@meowerse/auth";

/** meowsenger's OIDC client, registered via `bun run provision` (config-as-code). */
export const meowsengerClient = defineAuthClient({
  name: "meowsenger",
  displayName: "meowsenger",
  clientType: "confidential",
  redirectUris: [
    "https://meowsenger.alxnko.dev/auth/callback",
    "https://meowsenger.alxnko.eu.org/auth/callback",
    // dev (`wrangler dev`): auth only registers http for literal loopback, not "localhost"
    "http://127.0.0.1:8787/auth/callback",
  ],
  postLogoutRedirectUris: [
    "https://meowsenger.alxnko.dev",
    "https://meowsenger.alxnko.eu.org",
    "http://127.0.0.1:8787",
  ],
  scopes: ["openid", "profile", "verified"],
  allowOfflineAccess: true,
});
