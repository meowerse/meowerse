import { test, expect } from "vitest";
import { getClient } from "../src/clients";
import { routedDb, type Route } from "./helpers";

const clientRoutes: Route[] = [
  [
    /FROM oauth_clients WHERE client_id/,
    () => ({
      rows: [
        {
          client_id: "mw_demo",
          status: "active",
          client_type: "public",
          display_name: "Demo",
          logo_url: null,
          allowed_scopes: '["openid","profile"]',
          verified_only: 0,
          first_party: 0,
        },
      ],
    }),
  ],
  [/FROM oauth_client_redirect_uris/, () => ({ rows: [{ redirect_uri: "https://app/cb" }] })],
];

test("getClient parses scopes + redirect uris", async () => {
  const c = await getClient(routedDb(clientRoutes), "mw_demo");
  expect(c).toMatchObject({
    clientId: "mw_demo",
    allowedScopes: ["openid", "profile"],
    redirectUris: ["https://app/cb"],
    verifiedOnly: false,
    firstParty: false,
  });
});

test("getClient returns null for unknown id and empty id", async () => {
  expect(await getClient(routedDb([[/FROM oauth_clients/, () => ({ rows: [] })]]), "nope")).toBeNull();
  expect(await getClient(routedDb([]), "")).toBeNull();
});

test("malformed allowed_scopes degrades to empty list (never throws)", async () => {
  const routes: Route[] = [
    [/FROM oauth_clients WHERE client_id/, () => ({ rows: [{ client_id: "c", status: "active", client_type: "public", display_name: null, logo_url: null, allowed_scopes: "not json", verified_only: 1, first_party: 1 }] })],
    [/FROM oauth_client_redirect_uris/, () => ({ rows: [] })],
  ];
  const c = await getClient(routedDb(routes), "c");
  expect(c?.allowedScopes).toEqual([]);
  expect(c?.verifiedOnly).toBe(true);
  expect(c?.firstParty).toBe(true);
});
