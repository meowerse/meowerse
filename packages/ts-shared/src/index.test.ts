import { describe, expect, test } from "bun:test";
import { MAX_MESSAGE_BODY, slugify } from "./index";

describe("index exports", () => {
  test("re-exports slugify", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });
  test("MAX_MESSAGE_BODY is the shared 4000-char body cap", () => {
    expect(MAX_MESSAGE_BODY).toBe(4000);
  });
});
