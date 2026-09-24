// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindCopyButtons } from "./copy-buttons";

function block() {
  document.body.replaceChildren();
  const pre = document.createElement("pre");
  pre.id = "c1";
  pre.textContent = 'import { Button } from "@meowerse/ui";';
  const btn = document.createElement("button");
  btn.dataset.copy = "c1";
  btn.textContent = "copy";
  const status = document.createElement("p");
  status.dataset.copyStatus = "c1";
  document.body.append(pre, btn, status);
  return { btn, status };
}

describe("copy buttons (B9: no silent failure)", () => {
  beforeEach(() => vi.useRealTimers());
  it("copies the block's text and says so, then resets", async () => {
    vi.useFakeTimers();
    const { btn, status } = block();
    const clip = { writeText: vi.fn(async () => {}) };
    bindCopyButtons(document, clip);
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("copied"));
    expect(clip.writeText).toHaveBeenCalledWith('import { Button } from "@meowerse/ui";');
    expect(status.textContent).toBe("copied to the clipboard");
    vi.advanceTimersByTime(2000);
    expect(btn.textContent).toBe("copy");
  });
  it("says how to copy by hand when the clipboard refuses or is missing", async () => {
    const { btn, status } = block();
    bindCopyButtons(document, { writeText: vi.fn(async () => { throw new Error("denied"); }) });
    btn.click();
    await vi.waitFor(() => expect(btn.textContent).toBe("copy failed"));
    expect(status.textContent).toBe("copy failed — select the code and copy it by hand");
    const second = block();
    bindCopyButtons(document, undefined);
    second.btn.click();
    await vi.waitFor(() => expect(second.btn.textContent).toBe("copy failed"));
  });
  it("binds each button once", async () => {
    const { btn } = block();
    const clip = { writeText: vi.fn(async () => {}) };
    bindCopyButtons(document, clip);
    bindCopyButtons(document, clip);
    btn.click();
    await vi.waitFor(() => expect(clip.writeText).toHaveBeenCalledTimes(1));
  });
});
