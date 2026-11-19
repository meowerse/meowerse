// Lab only (`bun scripts/prerender-check.ts`, after `bun run build`): proves the speculation rules are honored
// under the REAL CSP and headers, that scripts with effects stay quiet while a page is prerendered, and
// measures click latency with and without the rules.
//
// Why not Playwright: any DevTools/CDP session makes Chromium refuse prerendering ("PrerenderingDisabledByDevTools"),
// so a Playwright test can never see a prerender. This script drives a plain Chromium WITHOUT a CDP connection:
// a tiny script (/nav.js, same-origin so the CSP allows it) hops between / and /ui/ and reports to a front
// server (/__r), which forwards everything else to scripts/serve-dist.ts untouched.
// The copy of dist/ differs from production only by: nav.js, rules narrowed to the two hop targets and
// eagerness "immediate" (a real hover cannot be sent without CDP; the 700 ms wait before each hop plays the hover).
import { chromium } from "@playwright/test";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";

const HOPS = 6; // 6 hops; the first sample is dropped as warm-up: 5 samples
const root = process.cwd();
const tmp = "/var/tmp/meowerse-prerender-check";
const NAV = `(function(){
  var raw=window.fetch.bind(window),n=+(localStorage.getItem("n")||0);
  var send=function(o){raw("/__r?"+new URLSearchParams(o),{keepalive:true}).catch(function(){})};
  var st=function(){return document.prerendering?"prerender":"visit"};
  window.fetch=function(u){if(String(u).indexOf("/__r")!==0)send({e:"fetch",u:String(u),s:st()});return raw.apply(this,arguments)};
  var gc=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(){send({e:"gl",s:st()});return gc.apply(this,arguments)};
  addEventListener("securitypolicyviolation",function(e){send({e:"csp",d:e.violatedDirective+" "+e.blockedURI})});
  
  var arm=function(){requestAnimationFrame(function(){
    var c=+(localStorage.getItem("click")||0),nav=performance.getEntriesByType("navigation")[0];
    if(c)send({e:"sample",ms:Date.now()-c,act:nav.activationStart>0?1:0,p:location.pathname});
    if(n>=${HOPS}){send({e:"done"});return}
    localStorage.setItem("n",++n);
    setTimeout(function(){localStorage.setItem("click",Date.now());location.href=location.pathname==="/"?"/ui/":"/"},700);
  })};
  if(document.prerendering)document.addEventListener("prerenderingchange",arm,{once:true});
  else if(document.readyState==="loading")addEventListener("DOMContentLoaded",arm);else arm();
})();`;

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

function prepare(withRules: boolean): string {
  const dir = `${tmp}-${withRules ? "rules" : "base"}`;
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(root, "dist"), join(dir, "dist"), { recursive: true });
  const d = join(dir, "dist");
  writeFileSync(join(d, "nav.js"), NAV);
  for (const f of walk(d).filter((p) => p.endsWith(".html")))
    writeFileSync(f, readFileSync(f, "utf8").replace("<head>", '<head><script src="/nav.js"></script>'));
  const hp = join(d, "_headers");
  let headers = readFileSync(hp, "utf8");
  if (!withRules) headers = headers.replace(/^\s*Speculation-Rules:.*\n/m, "");
  writeFileSync(hp, headers);
  const rp = join(d, "speculation-rules.json");
  const rules = JSON.parse(readFileSync(rp, "utf8"));
  const target = { or: [{ href_matches: "/ui/" }, { href_matches: "/" }] };
  for (const r of rules.prerender) { r.eagerness = "immediate"; r.where.and.push(target); }
  rules.prefetch = [];
  writeFileSync(rp, JSON.stringify(rules));
  return dir;
}

type Ev = Record<string, string>;
async function run(withRules: boolean, port: number) {
  const dir = prepare(withRules);
  const inner = port + 100;
  const back = spawn("bun", [join(root, "scripts/serve-dist.ts"), String(inner)], { cwd: dir, stdio: "ignore" });
  const events: Ev[] = [];
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const front = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/__r") {
      const e = Object.fromEntries(u.searchParams) as Ev;
      events.push(e);
      if (e.e === "done") finish();
      res.writeHead(204).end();
      return;
    }
    const r = await fetch(`http://127.0.0.1:${inner}${req.url}`, { headers: { "accept-encoding": "identity" }, redirect: "manual" });
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (k !== "content-encoding" && k !== "content-length") out[k] = v; });
    res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, "127.0.0.1");
  await sleep(1500);
  const profile = `${tmp}-profile-${port}`;
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(chromium.executablePath(), ["--headless=new", "--no-sandbox", `--user-data-dir=${profile}`,
    "--enable-unsafe-swiftshader", `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  const timeout = setTimeout(finish, 60_000);
  await done;
  clearTimeout(timeout);
  chrome.kill(); back.kill(); front.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
  return events;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const fail = (m: string): never => { console.error(`FAIL: ${m}`); process.exit(1); };

const base = await run(false, 4411);
const spec = await run(true, 4412);
const samples = (ev: Ev[]) => ev.filter((e) => e.e === "sample").slice(1, 6);
const ms = (ev: Ev[]) => samples(ev).map((e) => Number(e.ms));
console.log(`baseline (no rules):   click->first frame ms ${JSON.stringify(ms(base))} median ${median(ms(base))}`);
console.log(`speculation rules:     click->first frame ms ${JSON.stringify(ms(spec))} median ${median(ms(spec))}`);

if (!base.some((e) => e.e === "done") || !spec.some((e) => e.e === "done")) fail("a run did not finish");
if (samples(base).some((e) => e.act !== "0")) fail("baseline unexpectedly activated a prerender");
if (samples(spec).length < 5 || samples(spec).some((e) => e.act !== "1")) fail(`every hop should activate a prerendered page: ${JSON.stringify(samples(spec))}`);
const bad = spec.filter((e) => e.e === "csp" || ((e.e === "fetch" || e.e === "gl") && e.s === "prerender"));
if (bad.length) fail(`side effects/CSP violations while prerendered: ${JSON.stringify(bad)}`);
const visitFx = spec.filter((e) => (e.e === "fetch" || e.e === "gl") && e.s === "visit").length;
console.log(`ok: ${samples(spec).length}/${samples(spec).length} hops activated a prerendered page under the real CSP; ` +
  `0 CSP violations; 0 fetch/WebGL calls while prerendering; ${visitFx} after activation`);
