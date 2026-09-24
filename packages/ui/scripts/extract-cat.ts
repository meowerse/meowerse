// alxnko.dev desk.glb → src/cat3d/cat.bin. Build-time only; the output is committed.
// Layout (little-endian): Uint32[4] [magic "CAT3" 0x43415433, bodyVerts, headVerts, 0],
// Float32[3] head pivot, Float32[3] head forward, Float32[3] bbox min, Float32[3] bbox size,
// then Int16[3] quantised positions — body+tail triangles first, then head (non-indexed, flat).
// Source: $CAT_GLB, else the newest desk.*.glb in alxnko.dev/public/scene (survives a rebake's new hash;
// only positions are read, so albedo changes don't matter).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Nearest ancestor's sibling alxnko.dev/public/scene (works from the main checkout and from worktrees). */
function sceneDir(): string {
  for (let d = dirname(fileURLToPath(import.meta.url)); d !== dirname(d); d = dirname(d)) {
    const s = join(d, "alxnko.dev", "public", "scene");
    if (existsSync(s)) return s;
  }
  throw new Error("alxnko.dev/public/scene not found above this script (set CAT_GLB)");
}

function newestDesk(): string {
  const dir = sceneDir();
  const found = readdirSync(dir)
    .filter((f) => /^desk\..+\.glb$/.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!found[0]) throw new Error(`no desk.*.glb in ${dir} (set CAT_GLB)`);
  return found[0];
}

const SRC = process.env.CAT_GLB ?? newestDesk();
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(SRC);
const nodes = new Map(doc.getRoot().listNodes().map((n) => [n.getName(), n]));

// glTF is Y-up; the renderer (and extras.forward, a raw Blender custom prop) are Z-up: (x, y, z)_gl → (x, -z, y).
const zUp = (x: number, y: number, z: number): [number, number, number] => [x, -z, y];

/** World-space Z-up triangle soup of a part; the mesh sits on the part node or its `<name>__geo` child. */
function triangles(name: string): number[] {
  const node = [nodes.get(name), nodes.get(`${name}__geo`)].find((n) => n?.getMesh());
  if (!node) throw new Error(`${name} not found in ${SRC}`);
  const m = node.getWorldMatrix();
  const out: number[] = [];
  for (const prim of node.getMesh()!.listPrimitives()) {
    const pos = prim.getAttribute("POSITION")!;
    const idx = prim.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    const p: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      pos.getElement(idx ? idx.getScalar(i) : i, p);
      out.push(...zUp(
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]));
    }
  }
  return out;
}

const headNode = nodes.get("cat_head");
if (!headNode) throw new Error(`cat_head not found in ${SRC}`);
const f0 = (headNode.getExtras() as { forward?: number[] }).forward ?? [0, -1, 0];
// Turn the whole cat about Z so the head's gaze points at -Y (the renderer's camera side; its head
// yaw is about Z and pitch about X, which assumes exactly that).
const turn = -Math.PI / 2 - Math.atan2(f0[1] ?? 0, f0[0] ?? 0);
const c = Math.cos(turn), s = Math.sin(turn);
const spin = (v: number[]) => {
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i]!, y = v[i + 1]!;
    v[i] = c * x - s * y;
    v[i + 1] = s * x + c * y;
  }
  return v;
};

const body = spin([...triangles("cat_body"), ...triangles("cat_tail")]);
const head = spin(triangles("cat_head"));
const pivot = spin(zUp(...headNode.getWorldTranslation())); // cat_head pivots at the neck (build.py)
const fwd = spin([f0[0] ?? 0, f0[1] ?? 0, f0[2] ?? 0]);
const all = [...body, ...head];
const axis = (k: number) => all.filter((_, i) => i % 3 === k);
const min = [0, 1, 2].map((k) => axis(k).reduce((a, b) => Math.min(a, b), Infinity));
const max = [0, 1, 2].map((k) => axis(k).reduce((a, b) => Math.max(a, b), -Infinity));
const size = max.map((v, k) => v - min[k]!);

const header = new Uint32Array([0x43415433, body.length / 3, head.length / 3, 0]);
const floats = new Float32Array([...pivot, ...fwd, ...min, ...size]);
const q = new Int16Array(all.length);
for (let i = 0; i < all.length; i++)
  q[i] = Math.round(((all[i]! - min[i % 3]!) / size[i % 3]!) * 65535 - 32768);
const out = new Uint8Array(header.byteLength + floats.byteLength + q.byteLength);
out.set(new Uint8Array(header.buffer), 0);
out.set(new Uint8Array(floats.buffer), header.byteLength);
out.set(new Uint8Array(q.buffer), header.byteLength + floats.byteLength);
writeFileSync(fileURLToPath(new URL("../src/cat3d/cat.bin", import.meta.url)), out);
console.log(`source: ${SRC}\npivot ${pivot.map((v) => v.toFixed(3))} forward ${fwd.map((v) => v.toFixed(3))} min ${min.map((v) => v.toFixed(3))} size ${size.map((v) => v.toFixed(3))}`);
console.log(`cat.bin: ${out.byteLength} bytes, ${body.length / 9 + head.length / 9} triangles`);
