// B9: a lazy island whose chunk never arrives becomes a plain error with a way out, not an endless wait.
import { setStatus } from "./status-dom";

export const ISLAND_TIMEOUT_MS = 10_000;

/** The island sets data-ready on `root` once mounted; otherwise the root's StatusLine turns into
 *  `message` (what didn't load, and what to do) with a real way out (B9: a plain-language message alone isn't a recovery path) — a button
 *  next to it that reloads the page, the same `.mw-status__action` slot StatusLine's own `action`
 *  prop renders into. `reload` defaults to the real `location.reload()`; a test injects its own (the
 *  real one is a non-configurable, non-writable own property on jsdom's `Location`, so it can't be
 *  spied on directly — the same shape `probe-runner.ts` uses for `fetchImpl`). */
export function watchIsland(root: HTMLElement, message: string, timeoutMs = ISLAND_TIMEOUT_MS, reload: () => void = () => location.reload()): () => void {
  const t = setTimeout(() => {
    if (root.hasAttribute("data-ready")) return;
    const p = root.querySelector<HTMLElement>(".mw-status");
    if (!p) return;
    setStatus(p, "fail", message);
    const action = document.createElement("span");
    action.className = "mw-status__action";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mw-btn mw-btn--secondary mw-btn--sm";
    btn.textContent = "reload";
    btn.addEventListener("click", reload);
    action.append(btn);
    p.append(action);
  }, timeoutMs);
  return () => clearTimeout(t);
}
