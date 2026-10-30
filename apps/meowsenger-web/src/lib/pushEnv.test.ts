import { describe, it, expect, vi, afterEach } from "vitest";
import { isIos, isStandalone, pushDiagnostics, recordPushError } from "./push";

afterEach(() => { vi.unstubAllGlobals(); recordPushError(null); });

describe("isIos", () => {
  it("is false without navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isIos()).toBe(false);
  });
  it("detects iPhone UA and iPadOS desktop-UA", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/120", platform: "iPhone", maxTouchPoints: 5 });
    expect(isIos()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 });
    expect(isIos()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/120", platform: "Linux armv8l", maxTouchPoints: 5 });
    expect(isIos()).toBe(false);
  });
});

describe("isStandalone", () => {
  it("is false without window", () => {
    vi.stubGlobal("window", undefined);
    expect(isStandalone()).toBe(false);
  });
  it("reads display-mode and the legacy navigator.standalone", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(isStandalone()).toBe(true);
    vi.stubGlobal("window", { matchMedia: () => { throw new Error("x"); } });
    vi.stubGlobal("navigator", { standalone: true });
    expect(isStandalone()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(isStandalone()).toBe(false);
  });
});

describe("pushDiagnostics", () => {
  it("reports unsupported with no endpoint data", async () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("window", undefined);
    recordPushError("key");
    expect(await pushDiagnostics()).toEqual({ permission: "unsupported", serviceWorker: false, subscription: false, lastError: "key" });
  });
  it("reports an active worker + subscription as booleans only", async () => {
    const reg = { active: {}, pushManager: { getSubscription: async () => ({ endpoint: "https://secret" }) } };
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => reg } });
    vi.stubGlobal("window", { PushManager: function () {}, Notification: {} });
    vi.stubGlobal("Notification", { permission: "granted" });
    const d = await pushDiagnostics();
    expect(d).toEqual({ permission: "granted", serviceWorker: true, subscription: true, lastError: null });
    expect(JSON.stringify(d)).not.toContain("secret");
  });
});
