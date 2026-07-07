import { test, expect } from "vitest";
import { userinfoClaims } from "../src/userinfo";
import { TYP, TOKEN_USE } from "@meowerse/auth-shared";
import { routedDb, type Route } from "./helpers";

const RES = "https://api.meow";
const ISS = "https://auth-api.alxnko.eu.org";
// userinfoClaims now reads profile + telegram + verified in ONE query.
const accRoute: Route = [
  /FROM accounts a/,
  () => ({ rows: [{ username: "neko", display_name: "Neko", avatar_url: "http://img/x.png", telegram_id: null, telegram_username: null, verified: 0 }] }),
];

test("rejects an id_token presented at userinfo (typ guard)", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ID },
    payload: { token_use: TOKEN_USE.ID, sub: "acct_1", scope: "openid profile", aud: "mw_demo" },
    resourceAud: RES,
    issuer: ISS,
  });
  expect(res.ok).toBe(false);
});

test("rejects an access token with the wrong (client) audience", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid profile", aud: "mw_demo" },
    resourceAud: RES,
    issuer: ISS,
  });
  expect(res.ok).toBe(false);
});

test("valid access token: not TG-linked → picture is null", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid profile", aud: RES },
    resourceAud: RES,
    issuer: ISS,
  });
  expect(res).toEqual({
    ok: true,
    claims: { sub: "acct_1", preferred_username: "neko", name: "Neko", picture: null },
  });
});

test("valid access token: TG-linked → picture is the avatar proxy URL", async () => {
  const linked: Route = [
    /FROM accounts a/,
    () => ({ rows: [{ username: "neko", display_name: "Neko", avatar_url: "http://img/x.png", telegram_id: 42, telegram_username: "nekotg", verified: 1 }] }),
  ];
  const res = await userinfoClaims(routedDb([linked]), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid profile", aud: RES },
    resourceAud: RES,
    issuer: ISS,
  });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.claims.picture).toBe(`${ISS}/avatar/acct_1`);
});

test("telegram + verified claims are derived live when scoped", async () => {
  const routes: Route[] = [
    [
      /FROM accounts a/,
      () => ({ rows: [{ username: "neko", display_name: "Neko", avatar_url: "http://img/x.png", telegram_id: 42, telegram_username: "nekotg", verified: 1 }] }),
    ],
  ];
  const res = await userinfoClaims(routedDb(routes), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid telegram verified", aud: RES },
    resourceAud: RES,
    issuer: ISS,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.claims).toMatchObject({ telegram_id: 42, telegram_username: "nekotg", verified: true });
  expect(res.claims.preferred_username).toBeUndefined(); // profile not scoped
});

test("telegram scope but no link omits the telegram claims", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid telegram", aud: RES },
    resourceAud: RES,
    issuer: ISS,
  });
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.claims.telegram_id).toBeUndefined();
});

test("missing account or missing sub → not ok", async () => {
  expect(
    (await userinfoClaims(routedDb([[/FROM accounts/, () => ({ rows: [] })]]), {
      header: { typ: TYP.ACCESS },
      payload: { token_use: TOKEN_USE.ACCESS, sub: "ghost", scope: "openid", aud: RES },
      resourceAud: RES,
      issuer: ISS,
    })).ok,
  ).toBe(false);
  expect(
    (await userinfoClaims(routedDb([]), {
      header: { typ: TYP.ACCESS },
      payload: { token_use: TOKEN_USE.ACCESS, sub: "", scope: "openid", aud: RES },
      resourceAud: RES,
      issuer: ISS,
    })).ok,
  ).toBe(false);
});
