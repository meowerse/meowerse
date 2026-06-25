import { test, expect } from "vitest";
import { userinfoClaims } from "../src/userinfo";
import { TYP, TOKEN_USE } from "@meowerse/auth-shared";
import { routedDb, type Route } from "./helpers";

const RES = "https://api.meow";
const accRoute: Route = [
  /SELECT username, display_name, avatar_url FROM accounts/,
  () => ({ rows: [{ username: "neko", display_name: "Neko", avatar_url: "http://img/x.png" }] }),
];

test("rejects an id_token presented at userinfo (typ guard)", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ID },
    payload: { token_use: TOKEN_USE.ID, sub: "acct_1", scope: "openid profile", aud: "mw_demo" },
    resourceAud: RES,
  });
  expect(res.ok).toBe(false);
});

test("rejects an access token with the wrong (client) audience", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid profile", aud: "mw_demo" },
    resourceAud: RES,
  });
  expect(res.ok).toBe(false);
});

test("valid access token returns scope-filtered claims with sub", async () => {
  const res = await userinfoClaims(routedDb([accRoute]), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid profile", aud: RES },
    resourceAud: RES,
  });
  expect(res).toEqual({
    ok: true,
    claims: { sub: "acct_1", preferred_username: "neko", name: "Neko", picture: "http://img/x.png" },
  });
});

test("telegram + verified claims are derived live when scoped", async () => {
  const routes: Route[] = [
    accRoute,
    [/telegram_id, telegram_username FROM telegram_links/, () => ({ rows: [{ telegram_id: 42, telegram_username: "nekotg" }] })],
    [/SELECT 1 FROM telegram_links/, () => ({ rows: [{ "1": 1 }] })],
  ];
  const res = await userinfoClaims(routedDb(routes), {
    header: { typ: TYP.ACCESS },
    payload: { token_use: TOKEN_USE.ACCESS, sub: "acct_1", scope: "openid telegram verified", aud: RES },
    resourceAud: RES,
  });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  expect(res.claims).toMatchObject({ telegram_id: 42, telegram_username: "nekotg", verified: true });
  expect(res.claims.preferred_username).toBeUndefined(); // profile not scoped
});

test("missing account or missing sub → not ok", async () => {
  expect(
    (await userinfoClaims(routedDb([[/FROM accounts/, () => ({ rows: [] })]]), {
      header: { typ: TYP.ACCESS },
      payload: { token_use: TOKEN_USE.ACCESS, sub: "ghost", scope: "openid", aud: RES },
      resourceAud: RES,
    })).ok,
  ).toBe(false);
  expect(
    (await userinfoClaims(routedDb([]), {
      header: { typ: TYP.ACCESS },
      payload: { token_use: TOKEN_USE.ACCESS, sub: "", scope: "openid", aud: RES },
      resourceAud: RES,
    })).ok,
  ).toBe(false);
});
