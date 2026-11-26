/** @vitest-environment happy-dom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { render, screen, fireEvent } from "../test/rtl";
import { LazyPanel, panels, prefetchPanels, preload } from "./LazyPanel";

const Hello = ({ name }: { name: string }) => <p>hello {name}</p>;

afterEach(() => { vi.useRealTimers(); delete (navigator as { connection?: unknown }).connection; });
const chunkErr = () => new Error("Failed to fetch dynamically imported module: /_astro/x.js");

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
    const load = vi.fn<() => Promise<{ default: typeof Hello }>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ default: Hello });
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

  it("a missing chunk offers reload immediately; a failed retry also becomes reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const a = render(<LazyPanel load={() => Promise.reject<{ default: typeof Hello }>(chunkErr())} props={{ name: "a" }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "reload" }));
    expect(reload).toHaveBeenCalled();
    a.unmount();
    const load = () => Promise.reject(new Error("offline"));
    render(<LazyPanel load={load} props={{ name: "b" }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "retry" }));
    expect(await screen.findByRole("button", { name: "reload" })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("re-opening an already-loaded panel renders synchronously, with no fallback", async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve({ default: Hello }));
    const first = render(<LazyPanel load={load} props={{ name: "d" }} onClose={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("hello d")).toBeTruthy();
    first.unmount();
    render(<LazyPanel load={load} props={{ name: "d" }} onClose={() => {}} />);
    expect(screen.getByText("hello d")).toBeTruthy(); // same tick: no Suspense
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("pending state appears only after 150 ms and is a status", async () => {
    vi.useFakeTimers();
    let done!: () => void;
    const load = () => new Promise<{ default: typeof Hello }>((r) => { done = () => r({ default: Hello }); });
    render(<LazyPanel load={load} props={{ name: "e" }} onClose={() => {}} />);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(160); });
    expect(screen.getByRole("status").textContent).toMatch(/loading/);
    await act(async () => { done(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("hello e")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays mounted after close, and a closed-and-failed panel retries on re-open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.fn<() => Promise<{ default: typeof Hello }>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ default: Hello });
    const { rerender } = render(<LazyPanel load={load} open props={{ name: "f" }} onClose={() => {}} />);
    await screen.findByRole("alert");
    rerender(<LazyPanel load={load} open={false} props={{ name: "f" }} onClose={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<LazyPanel load={load} open props={{ name: "f" }} onClose={() => {}} />);
    expect(await screen.findByText("hello f")).toBeTruthy();
    rerender(<LazyPanel load={load} open={false} props={{ name: "f" }} onClose={() => {}} />);
    expect(screen.getByText("hello f")).toBeTruthy(); // closed panels stay mounted (own exit behaviour)
  });

  it("focus returns to the trigger on retry, dismiss and Escape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    const load = vi.fn<() => Promise<{ default: typeof Hello }>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ default: Hello });
    const trig = document.createElement("button");
    document.body.append(trig);
    trig.focus();
    render(<LazyPanel load={load} props={{ name: "g" }} onClose={onClose} />);
    const retry = await screen.findByRole("button", { name: "retry" });
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(document.activeElement).toBe(trig);
    await screen.findByText("hello g");
    // Escape on a fresh failure
    const bad = () => Promise.reject(new Error("offline"));
    trig.focus();
    render(<LazyPanel load={bad} props={{ name: "h" }} onClose={onClose} />);
    const alerts = await screen.findAllByRole("alert");
    fireEvent.keyDown(alerts[0]!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(trig);
    trig.remove();
  });

  it("prefetchPanels skips Save-Data and 2g connections", () => {
    const ric = vi.fn(() => 1);
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = ric;
    try {
      for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
        Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
        prefetchPanels();
      }
      expect(ric).not.toHaveBeenCalled();
    } finally { delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback; }
  });

  it("preload() starts the chunk fetch for each named panel", () => {
    const spy = vi.spyOn(panels, "emoji").mockResolvedValue({ default: Hello } as never);
    preload("emoji")();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
