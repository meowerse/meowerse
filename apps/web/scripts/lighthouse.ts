// Lighthouse gate (B26), local only: dist/ served with the real _headers and gzip (serve-dist.ts), Lighthouse 13,
// median of 3 runs per page and form factor, headless Chromium without a GPU (--disable-gpu
// --enable-unsafe-swiftshader). Mobile: default throttling (4× CPU, slow 4G). Desktop: preset desktop with CPU ×3
// (the PSI-calibrated setup alxnko.dev used, R82). Every category must be ≥ 95. Reports: /var/tmp/brand-v2/sp2/lh.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = 4372, RUNS = 3, MIN = 95;
const OUT = "/var/tmp/brand-v2/sp2/lh";
const PAGES = ["/", "/p/meowsenger/", "/ui/", "/ui/components/button/", "/ui/playground/"];
const CATS = ["performance", "accessibility", "best-practices", "seo"] as const;
mkdirSync(OUT, { recursive: true });
// Playwright's Chromium, never whatever Chrome is installed: chrome-launcher silently falls back to a system
// Chrome when CHROME_PATH doesn't exist, and that would measure a different browser without saying so.
const CHROME = chromium.executablePath();
if (!existsSync(CHROME)) throw new Error(`Playwright's Chromium isn't installed at ${CHROME}: run \`bunx playwright install chromium\` (or set PLAYWRIGHT_BROWSERS_PATH)`);

const server = spawn("bun", ["scripts/serve-dist.ts", String(PORT)], { stdio: "ignore" });
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try { up = (await fetch(base)).ok; } catch { /* not up yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 100));
}
if (!up) { server.kill(); throw new Error(`serve-dist didn't answer on ${base} (is dist/ built? is port ${PORT} free?)`); }

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const failures: string[] = [];
try {
  for (const path of PAGES) {
    for (const ff of ["mobile", "desktop"] as const) {
      const scores: Record<string, number[]> = Object.fromEntries(CATS.map((c) => [c, []]));
      const bench: number[] = [];
      for (let run = 0; run < RUNS; run++) {
        const file = `${OUT}/${path.replace(/\//g, "_") || "_"}-${ff}-${run}.json`;
        const args = ["lighthouse@13", `${base}${path}`, "--quiet", "--output=json", `--output-path=${file}`,
          `--only-categories=${CATS.join(",")}`, "--chrome-flags=--headless=new --disable-gpu --enable-unsafe-swiftshader --no-sandbox",
          ...(ff === "desktop" ? ["--preset=desktop", "--throttling.cpuSlowdownMultiplier=3"] : [])];
        const r = spawnSync("bunx", args, { env: { ...process.env, CHROME_PATH: CHROME }, stdio: "inherit" });
        if (r.status !== 0) throw new Error(`lighthouse failed on ${path} (${ff})`);
        const lhr = JSON.parse(readFileSync(file, "utf8"));
        for (const c of CATS) scores[c]!.push(Math.round(lhr.categories[c].score * 100));
        bench.push(lhr.environment.benchmarkIndex);
      }
      const med = Object.fromEntries(CATS.map((c) => [c, median(scores[c]!)]));
      console.log(`${path.padEnd(26)} ${ff.padEnd(8)} ${CATS.map((c) => `${c} ${med[c]}`).join("  ")}  (benchmarkIndex ${median(bench)})`);
      if (median(bench) < 1500) console.warn(`  warning: benchmarkIndex ${median(bench)} is low; the machine is busy or slow, so re-run when it is idle`);
      for (const c of CATS) if (med[c]! < MIN) failures.push(`${path} ${ff} ${c} ${med[c]} < ${MIN}`);
    }
  }
} finally {
  server.kill();
}
if (failures.length) { console.error(`\n${failures.join("\n")}`); process.exit(1); }
