import { describe, expect, it } from "vitest";
import { aim, ease, lookAt, multiply, perspective, rgb, rotateYX } from "./math";

describe("cat3d math", () => {
  it("aim maps the pointer to clamped yaw/pitch (degrees → radians)", () => {
    expect(aim(0, 0)).toEqual({ yaw: 0, pitch: 0 });
    const r = aim(1, -1);
    expect(r.yaw).toBeCloseTo((35 * Math.PI) / 180);
    expect(r.pitch).toBeCloseTo((-20 * Math.PI) / 180);
    expect(aim(5, 5)).toEqual(aim(1, 1));
  });
  it("ease approaches the target and never overshoots", () => {
    const v = ease(0, 1, 1 / 60);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    expect(ease(0, 1, 10)).toBeCloseTo(1, 5);
  });
  it("identity-ish sanity: rotateYX(0,0) is identity; perspective/lookAt are finite", () => {
    expect(Array.from(rotateYX(0, 0, [1, 2, 3]))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const vp = multiply(perspective(0.6, 1, 0.01, 10), lookAt([0, -1, 0.5], [0, 0, 0], [0, 0, 1]));
    expect(vp.every(Number.isFinite)).toBe(true);
  });
  it("rgb parses #rrggbb and #rgb; anything else falls back to the cat green #14995a", () => {
    expect(rgb("#ff0080")).toEqual([1, 0, 128 / 255]);
    expect(rgb("#F08")).toEqual([1, 0, 136 / 255]);
    const green = [0x14 / 255, 0x99 / 255, 0x5a / 255];
    for (const bad of ["", "14995a", "#12345", "#ggg", "rgb(0,0,0)", " #fff", "#ff008080"]) expect(rgb(bad)).toEqual(green);
  });
});
