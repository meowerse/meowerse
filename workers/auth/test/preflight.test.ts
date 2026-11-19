import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../../infra/cloudflare/preflight-auth.sh", import.meta.url).pathname;
function run(listing: string, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "pf-"));
  const fake = join(dir, "fake-wrangler");
  writeFileSync(fake, `#!/bin/sh\ncat <<'EOF'\n${listing}\nEOF\nexit ${exit}\n`);
  chmodSync(fake, 0o755);
  return spawnSync("bash", [script], { env: { ...process.env, WRANGLER_CMD: fake }, encoding: "utf8" });
}

test("deploy preflight: passes only when STATE_SECRET is listed; fails closed otherwise; prints no values", () => {
  const ok = run('[{"name":"AUTH_SIGNING_KEYS","type":"secret_text"},{"name":"STATE_SECRET","type":"secret_text"}]');
  expect(ok.status).toBe(0);
  const missing = run('[{"name":"AUTH_SIGNING_KEYS","type":"secret_text"}]');
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("STATE_SECRET");
  const broken = run("", 1);
  expect(broken.status).toBe(1);
  expect(ok.stdout + ok.stderr).not.toMatch(/secret_text|AUTH_SIGNING/);
});

test("preflight is wired before every auth deploy (package.json deploy script and deploy.yml)", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  expect(pkg.scripts.deploy).toMatch(/^bash \.\.\/\.\.\/infra\/cloudflare\/preflight-auth\.sh && wrangler deploy$/);
  const wf = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const step = wf.slice(wf.indexOf("Deploy auth (one Worker"), wf.indexOf("Deploy meowsenger"));
  expect(step.indexOf("infra/cloudflare/preflight-auth.sh")).toBeGreaterThan(-1);
  expect(step.indexOf("infra/cloudflare/preflight-auth.sh")).toBeLessThan(step.indexOf("wrangler deploy"));
});
