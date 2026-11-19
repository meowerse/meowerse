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
