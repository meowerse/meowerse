import { afterEach, expect, test, vi } from "vitest";
import { listMeows, createMeow } from "./api";

afterEach(() => vi.restoreAllMocks());

test("listMeows GETs with bearer and parses", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify([{ id: 1, text: "hi", slug: "hi", created_at: "" }]), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const out = await listMeows("http://x", "tok");
  expect(fetchMock).toHaveBeenCalledWith("http://x/api/meows", {
    headers: { Authorization: "Bearer tok" },
  });
  expect(out[0].slug).toBe("hi");
});

test("createMeow POSTs json", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 2, text: "yo", slug: "yo", created_at: "" }), { status: 201 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const m = await createMeow("http://x", "tok", "yo");
  expect(m.slug).toBe("yo");
  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe("http://x/api/meows");
  expect(opts.method).toBe("POST");
  expect(opts.headers).toEqual({
    Authorization: "Bearer tok",
    "Content-Type": "application/json",
  });
  expect(opts.body).toBe(JSON.stringify({ text: "yo" }));
});

test("listMeows throws on non-ok", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 500 })));
  await expect(listMeows("http://x", "tok")).rejects.toThrow();
});

test("createMeow throws on non-ok", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 500 })));
  await expect(createMeow("http://x", "tok", "yo")).rejects.toThrow();
});
