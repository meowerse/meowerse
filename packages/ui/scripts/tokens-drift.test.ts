import { describe, expect, it } from "vitest";
import { drift } from "./tokens-drift";

describe("drift", () => {
  it("reports differing and missing leaves by path", () => {
    expect(drift({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 3, z: 4 } })).toEqual(["a.y", "a.z"]);
  });
  it("is empty for equal trees", () => {
    expect(drift({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
  });
});
