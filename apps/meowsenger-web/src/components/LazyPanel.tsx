import { Component, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";

// On-demand panels (modals, menus, drawer) live in their own chunks so they are not in the eager /app closure.
// Rendered only once opened; the chunk is warmed after first paint (prefetchPanels) so a click rarely waits.
type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

export const panels = {
  menu: () => import("./MessageMenu").then((m) => ({ default: m.MessageMenu })),
  emoji: () => import("./EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
  search: () => import("./SearchPanel").then((m) => ({ default: m.SearchPanel })),
  newChat: () => import("./NewChatModal").then((m) => ({ default: m.NewChatModal })),
  forward: () => import("./ForwardModal").then((m) => ({ default: m.ForwardModal })),
  members: () => import("./MemberDrawer").then((m) => ({ default: m.MemberDrawer })),
  settings: () => import("./Settings"),
};

/** Hover/focus preload for a trigger: starts the chunk fetch early; failures are ignored (the click shows them). */
export const preload = (...keys: (keyof typeof panels)[]) => () => keys.forEach((k) => void panels[k]().catch(() => {}));

/** Warm every panel chunk when the browser is idle (skipped on Save-Data and 2g/slow-2g). Failures are ignored: the click retries visibly. */
export function prefetchPanels(): () => void {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (c?.saveData || /^(slow-)?2g$/.test(c?.effectiveType ?? "")) return () => {};
  const run = () => Object.values(panels).forEach((l) => void l().catch(() => {}));
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
  if (w.requestIdleCallback) { const h = w.requestIdleCallback(run, { timeout: 3000 }); return () => w.cancelIdleCallback?.(h); }
  const t = window.setTimeout(run, 1500);
  return () => clearTimeout(t);
}

// One lazy component per loader for the page's life, so a re-open of a loaded panel renders synchronously (no Suspense tick).
// React.lazy caches a rejection forever, so a failed entry is dropped and rebuilt on the next request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPanel = LazyExoticComponent<ComponentType<any>>;
const cache = new WeakMap<object, AnyPanel>();
function getPanel<P>(load: Loader<P>): AnyPanel {
  let c = cache.get(load);
  if (!c) {
    c = lazy(() => load().catch((e) => { cache.delete(load); throw e; }));
    cache.set(load, c);
  }
  return c;
}

// A missing hashed chunk (stale deploy) 404s forever and engines may cache the failed import() per URL, so retrying is pointless.
const isChunkError = (e: unknown) => /dynamically imported module|importing a module script|error loading dynamically|failed to fetch/i.test(String((e as Error)?.message ?? e));

class Boundary extends Component<{ onError: (e: unknown) => void; fallback: (e: unknown) => ReactNode; children: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };
  static getDerivedStateFromError(error: unknown) { return { error, failed: true }; }
  componentDidCatch(e: unknown) { this.props.onError(e); }
  render() { return this.state.failed ? this.props.fallback(this.state.error) : this.props.children; }
}

// Only shown if the chunk is still loading after 150 ms, so fast loads do not flash. Fixed-position like the alert: zero layout shift.
function Pending() {
  const [show, setShow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShow(true), 150); return () => clearTimeout(t); }, []);
  return show ? <div className="mw-apptoast" role="status">loading…</div> : null;
}

/**
 * Renders `load()`'s component with `props` once `open` (default: while mounted). Stays mounted after the first open so
 * the panel keeps its own state/exit behaviour. A failed chunk load (offline / stale deploy) shows an honest alert: "retry"
 * for a transient failure, "reload" once retrying cannot help (missing chunk, or a retry already failed). Focus returns to the trigger.
 */
export function LazyPanel<P extends object>({ load, props, open = true, onClose }: { load: Loader<P>; props: P; open?: boolean; onClose: () => void }) {
  const [gen, setGen] = useState(0);
  const [err, setErr] = useState<unknown>(null);
  const retried = useRef(false);
  const seen = useRef(false);
  const trigger = useRef<Element | null>(null);
  if (open && !seen.current) trigger.current = document.activeElement; // the trigger still has focus when the panel is first requested
  if (open) seen.current = true;
  // Closing a failed panel forgets the failure, so re-opening tries again.
  useEffect(() => { if (!open && err) { setErr(null); retried.current = false; setGen((n) => n + 1); } }, [open, err]);
  if (!seen.current) return null;
  const Panel = getPanel(load);
  const back = () => { const t = trigger.current as HTMLElement | null; if (t?.isConnected) t.focus(); };
  const dismiss = () => { back(); onClose(); };
  return (
    <Boundary
      key={gen}
      onError={setErr}
      fallback={(e) => {
        if (!open) return null;
        const reload = retried.current || isChunkError(e);
        return (
          <div className="mw-apptoast" role="alert" onKeyDown={(ev) => { if (ev.key === "Escape") dismiss(); }}>
            <span>{reload ? "couldn't load this panel. it may have been updated; reload the page." : "couldn't load this panel. check your connection."}</span>{" "}
            <button autoFocus className="mw-btn mw-btn--sm" onClick={reload ? () => location.reload() : () => { retried.current = true; back(); setErr(null); setGen((n) => n + 1); }}>{reload ? "reload" : "retry"}</button>{" "}
            <button className="mw-btn mw-btn--sm" onClick={dismiss}>dismiss</button>
          </div>
        );
      }}
    >
      <Suspense fallback={<Pending />}>
        <Panel {...props} />
      </Suspense>
    </Boundary>
  );
}
