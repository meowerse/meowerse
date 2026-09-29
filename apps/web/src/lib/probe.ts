// Live service status (spec §5, B9): one CORS request with a timeout, and an honest reading of it.
// Doesn't reuse @meowerse/ui's request(): that helper always sends credentials: "include", which a
// public CORS endpoint answering Access-Control-Allow-Origin: "*" must reject (the fetch spec forbids
// credentialed requests against a wildcard ACAO), so it would fail every probe outright.
import type { StatusState } from "@meowerse/ui";

export const PROBE_TIMEOUT_MS = 5000;

export type ProbeResult =
  | { state: "up"; ms: number }
  | { state: "down"; status: number }
  | { state: "unknown"; reason: "timeout" | "network" };

type ProbeOpts = { method?: "GET" | "HEAD"; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number };

/** Never throws. An error status is "down"; no answer or a blocked request is "unknown", never "down". */
export async function probe(url: string, opts: ProbeOpts = {}): Promise<ProbeResult> {
  const { method = "GET", timeoutMs = PROBE_TIMEOUT_MS, now = () => performance.now() } = opts;
  const fetchImpl = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const t0 = now();
  try {
    const res = await fetchImpl(url, { method, mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow", signal: ac.signal });
    const ms = now() - t0;
    res.body?.cancel().catch(() => { /* only the status matters */ });
    return res.ok ? { state: "up", ms } : { state: "down", status: res.status };
  } catch {
    return { state: "unknown", reason: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** The StatusLine state and our lowercase copy for a probe outcome. */
export function describeProbe(name: string, r: ProbeResult | "pending", timeoutMs = PROBE_TIMEOUT_MS): { state: StatusState; text: string } {
  if (r === "pending") return { state: "wait", text: `${name} — checking…` };
  switch (r.state) {
    case "up": return { state: "ok", text: `${name} — up · ${Math.max(1, Math.round(r.ms))} ms` };
    case "down": return { state: "fail", text: `${name} — down · answered ${r.status}` };
    case "unknown":
      return {
        state: "info",
        text: r.reason === "timeout" ? `${name} — unknown · no answer in ${timeoutMs / 1000} s` : `${name} — unknown · couldn't reach it from here`,
      };
  }
}
