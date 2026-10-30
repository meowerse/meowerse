/** @vitest-environment happy-dom */
/** Real push.ts (not mocked): requestPermission must run synchronously inside the click. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "../test/rtl";

vi.mock("../lib/chat", async (importActual) => ({
  ...(await importActual<typeof import("../lib/chat")>()),
  getPrivacy: vi.fn(async () => ({ allowAutoGroupAdd: true })),
}));

import Settings from "./Settings";

describe("push switch — user activation", () => {
  it("calls Notification.requestPermission synchronously in the click handler (before any await)", async () => {
    const order: string[] = [];
    const requestPermission = vi.fn(async () => { order.push("requestPermission"); return "default"; });
    vi.stubGlobal("Notification", Object.assign(function () {}, { permission: "default", requestPermission }));
    (window as unknown as Record<string, unknown>).PushManager = function () {};
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => undefined, register: vi.fn(), ready: new Promise(() => {}) },
    });
    render(<Settings base="https://x" userId="u1" open onClose={() => {}} />);
    const sw = screen.getByRole("switch", { name: /push notifications/ });
    order.push("before-click");
    fireEvent.click(sw);
    order.push("after-click-sync");
    expect(order).toEqual(["before-click", "requestPermission", "after-click-sync"]);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole("alert")).textContent).toMatch(/dismissed or hidden/);
  });
});
