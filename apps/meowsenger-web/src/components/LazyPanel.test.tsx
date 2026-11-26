/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../test/rtl";
import { LazyPanel, prefetchPanels } from "./LazyPanel";

const Hello = ({ name }: { name: string }) => <p>hello {name}</p>;

describe("LazyPanel", () => {
  it("renders nothing and does not load until opened", async () => {
    const load = vi.fn(() => Promise.resolve({ default: Hello }));
    const { rerender } = render(<LazyPanel load={load} open={false} props={{ name: "a" }} onClose={() => {}} />);
    expect(load).not.toHaveBeenCalled();
    rerender(<LazyPanel load={load} open props={{ name: "a" }} onClose={() => {}} />);
    expect(await screen.findByText("hello a")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a failed chunk load shows an honest retry state; retry loads the panel, dismiss closes", async () => {
    const load = vi.fn<() => Promise<{ default: typeof Hello }>>().mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module")).mockResolvedValue({ default: Hello });
    const onClose = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<LazyPanel load={load} props={{ name: "b" }} onClose={onClose} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load/);
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(await screen.findByText("hello b")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismiss calls onClose", async () => {
    const load = () => Promise.reject(new Error("offline"));
    const onClose = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<LazyPanel load={load} props={{ name: "c" }} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "dismiss" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("prefetchPanels waits for idle (never synchronous) and is cancellable", () => {
    const w = window as unknown as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };
    const ric = vi.fn(() => 7), cic = vi.fn();
    w.requestIdleCallback = ric; w.cancelIdleCallback = cic;
    try {
      const cancel = prefetchPanels();
      expect(ric).toHaveBeenCalledTimes(1); // scheduled, the chunk imports have not been triggered inline
      cancel();
      expect(cic).toHaveBeenCalledWith(7);
    } finally { delete w.requestIdleCallback; delete w.cancelIdleCallback; }
  });
});
