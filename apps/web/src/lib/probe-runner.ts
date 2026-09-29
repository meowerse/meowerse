// Drives every [data-probe] row on a page (ProjectStatus.astro) and the [data-probe-retry] buttons:
// a visible wait, a 5 s timeout, plain results, and a retry that reads busy while it runs (B9).
import { describeProbe, probe, PROBE_TIMEOUT_MS } from "./probe";
import { setStatus } from "./status-dom";

type Opts = { fetchImpl?: typeof fetch; timeoutMs?: number; watch?: boolean };

export function runProbes(doc: Document = document, opts: Opts = {}): Promise<void> {
  const { fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, watch = false } = opts;
  const rows = [...doc.querySelectorAll<HTMLElement>("[data-probe]")];
  const retry = [...doc.querySelectorAll<HTMLButtonElement>("[data-probe-retry]")];
  if (!rows.length) return Promise.resolve();
  let running: Promise<void> | null = null;

  const busy = (on: boolean) => {
    for (const b of retry) {
      b.hidden = false;
      // aria-disabled, not the disabled attribute: a real `disabled` would drop keyboard focus from
      // a button the user just clicked, the moment the run starts. The click handler below still
      // ignores clicks while busy (the `running` guard, not this attribute), so this only needs to
      // announce and look disabled, not actually block input.
      if (on) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
      b.textContent = on ? "checking…" : "check again";
      if (on) b.setAttribute("aria-busy", "true");
      else b.removeAttribute("aria-busy");
    }
  };

  const run = (): Promise<void> => {
    if (running) return running;
    busy(true);
    running = Promise.all(rows.map(async (row) => {
      const p = row.querySelector<HTMLElement>(".mw-status");
      if (!p) return;
      const name = row.dataset.name ?? "service";
      const wait = describeProbe(name, "pending", timeoutMs);
      setStatus(p, wait.state, wait.text);
      const r = await probe(row.dataset.url ?? "", { method: row.dataset.method === "HEAD" ? "HEAD" : "GET", timeoutMs, fetchImpl });
      const d = describeProbe(name, r, timeoutMs);
      setStatus(p, d.state, d.text);
      row.dataset.state = r.state;
    })).then(() => { busy(false); running = null; });
    return running;
  };

  for (const b of retry) b.addEventListener("click", () => void run());
  if (watch) addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) void run(); });

  // A backgrounded tab shouldn't spend its probe budget (or show a stale timestamp) before anyone
  // looks: wait for the tab to actually become visible before the first run.
  if (doc.hidden) {
    return new Promise<void>((resolve) => {
      const onVisible = () => {
        if (doc.hidden) return;
        doc.removeEventListener("visibilitychange", onVisible);
        run().then(resolve);
      };
      doc.addEventListener("visibilitychange", onVisible);
    });
  }
  return run();
}
