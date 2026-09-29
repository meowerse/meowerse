import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Deploy wiring is easy to break silently; these guard the audit fixes (W-11, W-12, W-14, B24).
const root = join(__dirname, "../../../..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("deploy config", () => {
  it("CI deploys web to production, not a preview (W-11)", () => {
    const y = read(".github/workflows/deploy.yml");
    const web = y.slice(y.indexOf("name: Deploy web"), y.indexOf("name: Deploy worker"));
    expect(web).toMatch(/wrangler pages deploy apps\/web\/dist --project-name meowerse-web --branch main /);
  });
  it.each(["web", "auth", "meowsenger"])("%s redeploys when packages/ui or packages/brand change (W-12)", (svc) => {
    const sh = new RegExp(`\\b${svc}\\)\\s+echo "([^"]+)"`).exec(read("infra/services.sh"))?.[1] ?? "";
    const tf = new RegExp(`\\b${svc} = \\{\\s*(?:#[^\\n]*\\n\\s*)*paths\\s*=\\s*"([^"]+)"`).exec(read("infra/cloudflare/deploy.tf"))?.[1] ?? "";
    for (const paths of [sh, tf]) {
      expect(paths, svc).toContain("packages/ui");
      expect(paths, svc).toContain("packages/brand");
    }
    expect(read(`infra/cloudflare/deploy-${svc}.sh`)).toMatch(/git status --porcelain -- [^|]*packages\/ui packages\/brand/);
  });
  it.each(["web", "auth", "meowsenger"])("CI detects %s changes on the same paths (W-12)", (svc) => {
    const pattern = new RegExp(`grep -qE '\\^\\(([^)]+)\\)' <<<"\\$diff" && echo "${svc}=1"`).exec(read(".github/workflows/deploy.yml"))?.[1] ?? "";
    expect(pattern, svc).toContain("packages/ui/");
    expect(pattern, svc).toContain("packages/brand/");
    if (svc === "web") expect(pattern).not.toContain("ts-shared");
  });
  it("deploy-status covers every service (W-14)", () =>
    expect(read("infra/deploy-status.sh")).toContain("for svc in api web worker auth meowsenger; do"));
  it("meow.alxnko.eu.org redirects to meow.alxnko.dev, not alxnko.dev (B24, W-15)", () => {
    const tf = read("infra/cloudflare/redirects.tf");
    expect(tf).toContain('expression  = "http.host == \\"meow.alxnko.eu.org\\""');
    expect(tf).toContain('expression = "concat(\\"https://meow.alxnko.dev\\", http.request.uri.path)"');
    expect(tf).toContain('expression  = "http.host in {\\"alxnko.eu.org\\" \\"www.alxnko.eu.org\\"}"');
  });
});
