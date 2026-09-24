// Cat3D renderer: dependency-free WebGL2, flat shading from screen-space derivatives (no normals stored;
// highp: in mediump the cross of mm-scale derivatives underflows to 0 → NaN normals),
// one directional light + ambient. Draws only while the head is easing — no idle frame loop.
// Not unit-tested (jsdom has no WebGL); scripts/cat-poster.ts verifies it end to end in Chromium.
import { aim, ease, lookAt, multiply, perspective, rgb, rotateYX, type Vec3 } from "./math";

const VS = `#version 300 es
in vec3 aPos; uniform mat4 uVP; uniform mat4 uModel; uniform vec3 uMin; uniform vec3 uSize;
out vec3 vWorld;
void main(){ vec3 p = uMin + (aPos / 65535.0 + 0.5) * uSize; vec4 w = uModel * vec4(p,1.0); vWorld = w.xyz; gl_Position = uVP * w; }`;
const FS = `#version 300 es
precision highp float; in vec3 vWorld; uniform vec3 uColor; uniform vec3 uLight; out vec4 o;
void main(){ vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld))); float d = max(dot(n, normalize(vec3(-0.4,-0.8,0.9))), 0.0);
  o = vec4(uColor * (0.35 + 0.65 * d) + uLight * pow(d, 12.0) * 0.25, 1.0); }`;

export function mount(canvas: HTMLCanvasElement, bin: ArrayBuffer, opts: { color: string; light: string }) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, powerPreference: "low-power" });
  if (!gl) return null;
  const fail = () => { gl.getExtension("WEBGL_lose_context")?.loseContext(); return null; }; // free the context now
  const [magic, bodyN = 0, headN = 0] = new Uint32Array(bin, 0, 4);
  if (magic !== 0x43415433) return fail();
  const f = Array.from(new Float32Array(bin, 16, 12));
  const v3 = (i: number): Vec3 => [f[i]!, f[i + 1]!, f[i + 2]!];
  const pivot = v3(0), min = v3(6), size = v3(9);
  const pos = new Int16Array(bin, 64, (bodyN + headN) * 3);

  const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  const shaders = [sh(gl.VERTEX_SHADER, VS), sh(gl.FRAGMENT_SHADER, FS)];
  for (const s of shaders) gl.attachShader(prog, s);
  gl.linkProgram(prog);
  for (const s of shaders) gl.deleteShader(s); // the linked program keeps what it needs
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fail();
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.SHORT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  gl.uniform3fv(U("uMin"), min); gl.uniform3fv(U("uSize"), size);
  gl.uniform3fv(U("uColor"), rgb(opts.color)); gl.uniform3fv(U("uLight"), rgb(opts.light));
  gl.enable(gl.DEPTH_TEST);

  const center: Vec3 = [min[0] + size[0] / 2, min[1] + size[1] / 2, min[2] + size[2] / 2];
  // fit the bounding sphere (radius r, 15% slack: the mesh is well inside it) in the 0.55 rad vertical FOV, seen from the front, slightly above and right
  const r = Math.hypot(...size) / 2, dist = (0.85 * r) / Math.sin(0.275), dir = [0.35, -1.6, 0.55], k = dist / Math.hypot(...dir);
  const eye: Vec3 = [center[0] + dir[0]! * k, center[1] + dir[1]! * k, center[2] + dir[2]! * k];
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0, raf = 0, last = 0, dirty = true;

  const frame = (now: number) => {
    raf = 0;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    yaw = ease(yaw, tYaw, dt); pitch = ease(pitch, tPitch, dt);
    const w = canvas.clientWidth * devicePixelRatio | 0, h = canvas.clientHeight * devicePixelRatio | 0;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(U("uVP"), false, multiply(perspective(0.55, w / h || 1, r * 0.1, dist + r * 2), lookAt(eye, center, [0, 0, 1])));
    gl.uniformMatrix4fv(U("uModel"), false, identity); gl.drawArrays(gl.TRIANGLES, 0, bodyN);
    // the head faces -Y, where a positive X rotation tips the gaze down: negate so +pitch (pointer above) looks up
    gl.uniformMatrix4fv(U("uModel"), false, rotateYX(yaw, -pitch, pivot)); gl.drawArrays(gl.TRIANGLES, bodyN, headN);
    const settled = Math.abs(yaw - tYaw) < 1e-4 && Math.abs(pitch - tPitch) < 1e-4;
    if (!settled || dirty) { dirty = false; raf = requestAnimationFrame(frame); } else last = 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  kick();
  return {
    setAim(px: number, py: number) { const a = aim(px, py); tYaw = a.yaw; tPitch = a.pitch; kick(); },
    /** Redraw once (after a resize / DPR change); a no-op while a frame is already queued. */
    kick() { dirty = true; kick(); },
    destroy() { cancelAnimationFrame(raf); gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}
