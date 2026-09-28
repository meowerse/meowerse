import { describe, expect, it } from "vitest";
import { PLAYABLE } from "./playable";
import { SEEDS } from "./seeds";

describe("playground registry", () => {
  it("has a component for every seed and nothing else", () => expect(Object.keys(PLAYABLE).sort()).toEqual(Object.keys(SEEDS).sort()));
});
