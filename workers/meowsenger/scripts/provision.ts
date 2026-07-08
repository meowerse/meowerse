// One-off: register/update meowsenger's OIDC client via the Management API.
// Usage: MGMT_TOKEN=<dev management token> bun run provision
// Prints the client_id (public → set as an OIDC_CLIENT_ID var) and, for a NEW
// confidential client, the client_secret (→ wrangler secret put OIDC_CLIENT_SECRET).
import { provision } from "@meowerse/auth";
import { meowsengerClient } from "../auth.config";

const issuer = process.env.OIDC_ISSUER ?? "https://auth.alxnko.eu.org";
const managementToken = process.env.MGMT_TOKEN;
if (!managementToken) {
  console.error("Set MGMT_TOKEN (create one in the auth dashboard → management tokens).");
  process.exit(1);
}
const r = await provision(meowsengerClient, { issuer, managementToken });
console.log(JSON.stringify(r, null, 2));
if (r.clientSecret) console.log("\nSet secret:  bunx wrangler secret put OIDC_CLIENT_SECRET   (paste the value above)");
if (r.clientId) console.log(`Add var:     OIDC_CLIENT_ID=${r.clientId}  → wrangler.jsonc vars`);
