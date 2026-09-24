// Cat3D math: pointer → head aim, frame-rate independent easing, and the few column-major mat4s the
// renderer needs (Z-up world; the cat faces -Y).
export type Vec3 = [number, number, number];
const D = Math.PI / 180;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** px,py in [-1,1] (clamped) → head yaw/pitch in radians. */
export function aim(px: number, py: number, maxYaw = 35, maxPitch = 20) {
  return { yaw: clamp(px, -1, 1) * maxYaw * D, pitch: clamp(py, -1, 1) * maxPitch * D };
}
/** Exponential approach: never overshoots, independent of frame rate. */
export function ease(current: number, target: number, dt: number, rate = 8) {
  return target + (current - target) * Math.exp(-rate * dt);
}
export function perspective(fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
export function lookAt(eye: Vec3, t: Vec3, up: Vec3) {
  const z = norm([eye[0] - t[0], eye[1] - t[1], eye[2] - t[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}
export function multiply(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
  return o;
}
/** Head model matrix: yaw about world Z (up), then pitch about X, both around the neck pivot. */
export function rotateYX(yaw: number, pitch: number, p: Vec3) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const r = new Float32Array([cy, sy, 0, 0, -sy * cp, cy * cp, sp, 0, sy * sp, -cy * sp, cp, 0, 0, 0, 0, 1]);
  const t = (m: Float32Array, v: Vec3) => { m[12] = v[0]; m[13] = v[1]; m[14] = v[2]; return m; };
  const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const m = multiply(t(identity(), p), multiply(r, t(identity(), [-p[0], -p[1], -p[2]])));
  return m.map((v) => (Object.is(v, -0) ? 0 : v));
}
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
