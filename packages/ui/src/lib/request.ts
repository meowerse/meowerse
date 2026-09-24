export type RequestError =
  | { kind: "timeout" }
  | { kind: "network" }
  | { kind: "unauthorized"; status: 401 }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "parse" };
export type RequestResult<T> = { ok: true; status: number; data: T } | { ok: false; error: RequestError };

export const DEFAULT_TIMEOUT_MS = 10_000;

async function body(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

/** fetch with a timeout, credentials, `res.ok` checks and a typed result — never throws. */
export async function request<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<RequestResult<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) ac.abort();
  try {
    const res = await fetch(url, { ...rest, credentials: "include", signal: ac.signal });
    if (res.status === 401) return { ok: false, error: { kind: "unauthorized", status: 401 } };
    if (!res.ok) return { ok: false, error: { kind: "http", status: res.status, body: await body(res) } };
    if (res.status === 204) return { ok: true, status: 204, data: null as T };
    try {
      return { ok: true, status: res.status, data: (await res.json()) as T };
    } catch {
      return { ok: false, error: { kind: "parse" } };
    }
  } catch {
    return { ok: false, error: timedOut ? { kind: "timeout" } : { kind: "network" } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** One plain-language sentence for any request failure (lowercase voice, B14 applies to our copy only). Apps pass their own code→copy map for backend-specific errors. */
export function describeError(e: RequestError, copy?: Readonly<Record<string, string>>): string {
  switch (e.kind) {
    case "timeout": return "the server took too long to answer. try again.";
    case "network": return "can't reach the server. check your connection and try again.";
    case "unauthorized": return "your session has ended. sign in again.";
    case "parse": return "the server sent an unexpected answer. try again.";
    case "http": {
      if (e.status === 429) return "too many tries. wait a minute and try again.";
      if (e.status >= 500) return "something went wrong on our side. try again.";
      const err = (e.body as { error?: unknown; message?: unknown } | null)?.error;
      if (typeof err === "string" && err && copy?.[err]) return copy[err];
      const msg = (e.body as { message?: unknown } | null)?.message;
      if (typeof msg === "string" && msg) return msg;
      if (e.status === 404) return "not found.";
      return "that didn't work. try again.";
    }
  }
}
