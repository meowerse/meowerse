// B9: a lazy island whose chunk never arrives becomes a plain error with a way out, not an endless wait.
import { setStatus } from "./status-dom";

export const ISLAND_TIMEOUT_MS = 10_000;

/** The island sets data-ready on `root` once mounted; otherwise the root's StatusLine turns into an error. */
export function watchIsland(root: HTMLElement, timeoutMs = ISLAND_TIMEOUT_MS): () => void {
  const t = setTimeout(() => {
    if (root.hasAttribute("data-ready")) return;
    const p = root.querySelector<HTMLElement>(".mw-status");
    if (p) setStatus(p, "fail", "the playground didn't load. reload the page to try again.");
  }, timeoutMs);
  return () => clearTimeout(t);
}
