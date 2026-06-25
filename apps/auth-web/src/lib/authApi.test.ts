import { afterEach, expect, test, vi } from "vitest";
import { postSignup, postLogin, postConsent, getPending, nextLocation } from "./authApi";

afterEach(() => vi.restoreAllMocks());

function mockJson(value: unknown, init?: ResponseInit) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(value), init));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("postSignup POSTs credentialed JSON and parses", async () => {
  const fetchMock = mockJson({ ok: true, recoveryCodes: ["A", "B"], csrf: "c", next: { action: "consent" } });
  const out = await postSignup("http://x", "neko", "password1234");
  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe("http://x/signup");
  expect(opts.method).toBe("POST");
  expect(opts.credentials).toBe("include");
  expect(JSON.parse(opts.body)).toEqual({ username: "neko", password: "password1234" });
  expect(out.recoveryCodes).toEqual(["A", "B"]);
});

test("postLogin and postConsent hit the right endpoints", async () => {
  const a = mockJson({ ok: true, next: { action: "redirect", url: "https://app/cb?code=1" } });
  await postLogin("http://x", "neko", "password1234");
  expect(a.mock.calls[0][0]).toBe("http://x/login");

  const b = mockJson({ redirect: "https://app/cb?code=1" });
  const res = await postConsent("http://x", "allow", "csrf1");
  expect(b.mock.calls[0][0]).toBe("http://x/consent");
  expect(JSON.parse(b.mock.calls[0][1].body)).toEqual({ decision: "allow", csrf: "csrf1" });
  expect(res.redirect).toContain("code=1");
});

test("getPending GETs credentialed", async () => {
  const m = mockJson({ client: { name: "Demo", logo: null }, scope: ["openid"], csrf: "c" });
  const p = await getPending("http://x");
  expect(m.mock.calls[0][0]).toBe("http://x/authorize/pending");
  expect(m.mock.calls[0][1].credentials).toBe("include");
  expect(p.client?.name).toBe("Demo");
});

test("nextLocation maps every action", () => {
  expect(nextLocation({ action: "redirect", url: "https://app/cb" })).toBe("https://app/cb");
  expect(nextLocation({ action: "redirect" })).toBe("/account"); // redirect without url falls through
  expect(nextLocation({ action: "consent" })).toBe("/consent");
  expect(nextLocation({ action: "verify_required" })).toBe("/verify");
  expect(nextLocation({ action: "done" })).toBe("/account");
  expect(nextLocation(undefined)).toBe("/account");
});
