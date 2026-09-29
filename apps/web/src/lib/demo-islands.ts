// B9 for the /ui demo islands: the server-rendered preview keeps its place (no layout shift) but is
// `inert` until React has hydrated it, so a control never looks ready while it can't respond. While it
// waits, a "[wait] loading the demo…" line shows over it; once the island's <astro-island> loses `ssr`
// (Astro removes it after hydrating) the stage turns live and the line goes. If the chunk never arrives,
// the shared island watchdog turns the line into a plain error with a reload control. Without JS the
// line stays [hidden] and the demo's <noscript> note explains why nothing responds (DemoIsland.astro).
import { ISLAND_TIMEOUT_MS, watchIsland } from "./island-watchdog";

export const DEMO_FAILED = "the demo didn't load. reload the page to try again.";

type Options = { timeoutMs?: number; reload?: () => void };

export function bindDemoIslands(doc: Document = document, { timeoutMs = ISLAND_TIMEOUT_MS, reload }: Options = {}): void {
  for (const shell of doc.querySelectorAll<HTMLElement>("[data-demo]")) {
    const stage = shell.querySelector<HTMLElement>("[data-demo-stage]");
    const wait = shell.querySelector<HTMLElement>("[data-demo-wait]");
    if (!stage || shell.dataset.bound) continue;
    shell.dataset.bound = "1";
    const pending = () => stage.querySelector("astro-island[ssr]") !== null;
    let cancel = () => {};
    let io: IntersectionObserver | undefined;
    const live = () => {
      stage.removeAttribute("inert");
      wait?.remove();
      shell.setAttribute("data-ready", "");
      mo.disconnect();
      io?.disconnect();
      cancel();
    };
    const mo = new MutationObserver(() => { if (!pending()) live(); });
    if (!pending()) { live(); continue; }
    if (wait) wait.hidden = false;
    mo.observe(stage, { subtree: true, attributes: true, attributeFilter: ["ssr"] });
    // client:visible only starts loading once the demo is on screen, so the clock starts then too:
    // a demo far down the page isn't "failed" just because nobody has scrolled to it yet.
    const start = () => { cancel = watchIsland(shell, DEMO_FAILED, timeoutMs, reload); };
    if (typeof IntersectionObserver === "undefined") { start(); continue; }
    io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io!.disconnect();
      start();
    });
    io.observe(shell);
  }
}
