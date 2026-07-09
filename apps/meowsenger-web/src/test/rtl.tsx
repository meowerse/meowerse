/**
 * Shared harness for the island behavior tests (happy-dom + @testing-library/react).
 * Importing this module installs the browser stubs the chat island needs but
 * happy-dom doesn't provide (WebSocket, IntersectionObserver, scrollIntoView) and a
 * controllable document.visibilityState. The chat logic drives real WebSockets and
 * reads document visibility, so a test can only exercise it black-box with these.
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

export * from "@testing-library/react";

/**
 * A fake WebSocket: records every frame the client sends and lets a test drive the
 * connection lifecycle (open/close) and push server frames in. `new WebSocket(url)`
 * in the component under test constructs one of these (we swap the global below).
 */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static reset() {
    MockWebSocket.instances = [];
  }
  /** The most recently constructed socket (the live one, after a reconnect). */
  static get last(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
  /** The most recent CONVERSATION (room) socket — the `<Chat>` view also opens a
   *  persistent inbox socket (realtime sidebar), so tests that mean the room socket
   *  must select it by URL rather than by "last constructed". */
  static get room(): MockWebSocket {
    return [...MockWebSocket.instances].reverse().find((s) => s.url.includes("/ws?chat="))!;
  }
  /** The most recent inbox socket (realtime sidebar deltas), or undefined. */
  static get inbox(): MockWebSocket | undefined {
    return [...MockWebSocket.instances].reverse().find((s) => s.url.includes("/inbox/ws"));
  }

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  /** Raw frame strings the client sent over this socket. */
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // ---- test controls ----
  /** Simulate the socket connecting (fires onopen after flipping readyState). */
  mockOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  /** Push a server frame to the client (JSON-encoded, as the real socket delivers). */
  mockEmit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Simulate an unexpected drop (server/network close) → triggers client reconnect. */
  mockDrop(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  /** Parsed view of everything the client sent over this socket. */
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

// ---- controllable document visibility ----
let _visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => _visibility,
});
Object.defineProperty(document, "hidden", {
  configurable: true,
  get: () => _visibility !== "visible",
});
/** Set the tab's visibility and fire the visibilitychange event the app listens for. */
export function setVisibility(v: DocumentVisibilityState): void {
  _visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

// ---- install browser stubs happy-dom lacks ----
// Fires the callback immediately on observe() with isIntersecting:true, so the
// jump-to-message flash path (which waits for the row to land on screen) runs.
class ImmediateIntersectionObserver {
  private cb: (entries: Array<{ isIntersecting: boolean; target: Element }>, obs: unknown) => void;
  constructor(cb: (entries: Array<{ isIntersecting: boolean; target: Element }>, obs: unknown) => void) {
    this.cb = cb;
  }
  observe(el: Element): void {
    this.cb([{ isIntersecting: true, target: el }], this);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

/** A spyable Notification stub (granted). Tests read MockNotification.instances. */
export class MockNotification {
  static permission: NotificationPermission = "granted";
  static instances: Array<{ title: string; body?: string }> = [];
  static reset() {
    MockNotification.instances = [];
  }
  constructor(title: string, opts?: { body?: string }) {
    MockNotification.instances.push({ title, body: opts?.body });
  }
}

/** Install the globals the island touches. Idempotent; called at import. */
function installGlobals(): void {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = ImmediateIntersectionObserver;
  (globalThis as unknown as { Notification: unknown }).Notification = MockNotification;
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  }
}
installGlobals();

// Reset per test: unmount the tree and clear the socket registry + visibility.
afterEach(() => {
  cleanup();
  MockWebSocket.reset();
  MockNotification.reset();
  MockNotification.permission = "granted";
  _visibility = "visible";
});
