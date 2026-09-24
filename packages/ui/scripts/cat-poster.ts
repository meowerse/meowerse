// Renders the rest pose with the real renderer in Chromium → src/cat3d/cat-poster.webp (320×320, transparent),
// and fails if WebGL2 is missing or the canvas is blank (proves renderer.ts + cat.bin work end to end).
// GPU: NVIDIA via EGL (same env as alxnko.dev video/capture); CAT_SWIFTSHADER=1 falls back to SwiftShader.
// Also writes aim.png (pointer at top-right) to the scratch dir to eyeball the head-turn direction.
import { chromium } from "playwright";
import { build } from "bun";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = import.meta.url;
const WORK = "/var/tmp/brand-v2/cat-poster";
const WEBP = fileURLToPath(new URL("../src/cat3d/cat-poster.webp", here));
mkdirSync(WORK, { recursive: true });
// bun's iife output ignores globalName, so a scratch entry exposes mount() as a page global instead.
const entry = `${WORK}/entry.ts`;
writeFileSync(entry, `import { mount } from ${JSON.stringify(fileURLToPath(new URL("../src/cat3d/renderer.ts", here)))};
(globalThis as unknown as { Cat: unknown }).Cat = { mount };\n`);
const out = await build({ entrypoints: [entry], outdir: WORK, minify: true, target: "browser", format: "iife" });
if (!out.success) throw new Error("bundle failed");
const js = readFileSync(`${WORK}/entry.js`, "utf8");
const bin = readFileSync(fileURLToPath(new URL("../src/cat3d/cat.bin", here))).toString("base64");
const html = `<!doctype html><body style="margin:0;background:transparent"><canvas id=c style="width:320px;height:320px"></canvas>
<script>${js}
const b=Uint8Array.from(atob("${bin}"),c=>c.charCodeAt(0)).buffer;
window.api=Cat.mount(document.getElementById('c'),b,{color:'#14995a',light:'#63d396'});</script>`;

const swift = process.env.CAT_SWIFTSHADER === "1";
const NV = { __EGL_VENDOR_LIBRARY_FILENAMES: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json", __NV_PRIME_RENDER_OFFLOAD: "1", __GLX_VENDOR_LIBRARY_NAME: "nvidia" };
const browser = await chromium.launch(swift
  ? { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] }
  : { args: ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist"], env: { ...process.env, ...NV } as Record<string, string> });
const page = await browser.newPage({ viewport: { width: 320, height: 320 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.waitForFunction(() => (window as unknown as { api: unknown }).api !== undefined);
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return { live: (window as unknown as { api: unknown }).api !== null, renderer: ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "?" };
});
console.log(`renderer: ${gpu.renderer}`);
if (!gpu.live) throw new Error("mount() returned null (no WebGL2 or shader link failed)");
await page.waitForTimeout(300);
const png = await page.locator("#c").screenshot({ omitBackground: true });
await page.evaluate(() => (window as unknown as { api: { setAim(x: number, y: number): void } }).api.setAim(1, 1));
await page.waitForTimeout(1200);
writeFileSync(`${WORK}/aim.png`, await page.locator("#c").screenshot({ omitBackground: true }));
await browser.close();
writeFileSync(`${WORK}/poster.png`, png);
if (png.length < 2000) throw new Error("renderer produced a blank canvas");

// cwebp isn't available here; ImageMagick writes the same lossy+alpha webp. Step quality down to fit 12 KB.
for (const q of [90, 85, 80, 75, 70]) {
  const r = Bun.spawnSync(["magick", `${WORK}/poster.png`, "-quality", String(q), "-define", "webp:alpha-quality=100",
    "-define", "webp:lossless=false", WEBP]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  const bytes = statSync(WEBP).size;
  if (bytes <= 12 * 1024) { console.log(`poster written (q${q}, ${bytes} bytes)`); process.exit(0); }
}
throw new Error("poster exceeds 12 KB even at q70");
