import { test, expect } from "./fixtures";

test("every response carries the strict security headers, 404s included", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "headers don't depend on the viewport");
  for (const path of ["/", "/does-not-exist/", "/favicon.svg"]) {
    const h = (await request.get(path)).headers();
    const csp = h["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toMatch(/script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/);
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("require-trusted-types-for 'script'; trusted-types 'none'");
    expect(csp, path).not.toMatch(/unsafe-(inline|eval)/);
    expect(h["strict-transport-security"], path).toBe("max-age=31536000; includeSubDomains; preload");
    expect(h["referrer-policy"], path).toBe("no-referrer");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["cross-origin-opener-policy"], path).toBe("same-origin");
    expect(h["cross-origin-resource-policy"], path).toBe("same-origin");
    expect(h["permissions-policy"], path).toContain("camera=()");
  }
});
