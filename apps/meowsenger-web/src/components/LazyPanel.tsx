import { Component, lazy, Suspense, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";

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

/** Warm every panel chunk when the browser is idle (skipped on Save-Data). Failures are ignored: the click retries visibly. */
export function prefetchPanels(): () => void {
  if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return () => {};
  const run = () => Object.values(panels).forEach((l) => void l().catch(() => {}));
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
  if (w.requestIdleCallback) { const h = w.requestIdleCallback(run, { timeout: 3000 }); return () => w.cancelIdleCallback?.(h); }
  const t = window.setTimeout(run, 1500);
  return () => clearTimeout(t);
}

class Boundary extends Component<{ fallback: (reset: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children; }
}

/**
 * Renders `load()`'s component with `props` once `open` (default: while mounted). Stays mounted after the first open so
 * the panel keeps its own state/exit behaviour. A failed chunk load (offline / stale deploy) shows an honest retry state.
 */
export function LazyPanel<P extends object>({ load, props, open = true, onClose }: { load: Loader<P>; props: P; open?: boolean; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(false);
  // React.lazy caches a rejection forever, so a retry needs a fresh lazy().
  const Panel = useMemo(() => lazy(load), [load, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  if (open) seen.current = true;
  if (!seen.current) return null;
  return (
    <Boundary
      key={attempt}
      fallback={() =>
        open ? (
          <div className="mw-apptoast" role="alert">
            <span>couldn't load this panel. check your connection.</span>{" "}
            <button className="mw-btn mw-btn--sm" onClick={() => setAttempt((n) => n + 1)}>retry</button>{" "}
            <button className="mw-btn mw-btn--sm" onClick={onClose}>dismiss</button>
          </div>
        ) : null
      }
    >
      <Suspense fallback={null}>
        <Panel {...props} />
      </Suspense>
    </Boundary>
  );
}
