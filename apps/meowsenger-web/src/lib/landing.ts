// Landing page ("/") helpers: forward old app deep links and warm the app's chunks on intent.
// Pure functions so they unit-test without a browser; src/pages/index.astro wires them up.

/** Old `/?chat=…` / `/#…` links (the app used to live at `/`) → the same query+hash on `/app/`; null = stay on the landing. */
export function appForward(loc: { search: string; hash: string }): string | null {
  return /[?&]chat=/.test(loc.search) || loc.hash.length > 1 ? `/app/${loc.search}${loc.hash}` : null;
}

/** Only hashed same-origin build chunks; the manifest is attacker-irrelevant (our own HTML) but never fetch anything else. */
export const WARM_URL = /^\/_astro\/[\w.-]+\.js$/;

export const warmUrls = (attr: string | null | undefined): string[] => (attr ?? "").split(" ").filter((u) => WARM_URL.test(u));

export const slowConnection = (c?: { saveData?: boolean; effectiveType?: string }): boolean =>
  !!c && (!!c.saveData || /(^|-)2g$/.test(c.effectiveType ?? ""));

/** Inject `<link rel=modulepreload>` for the chunks once, ~delay ms after intent (hover / focus-visible / press); leaving or a touch scroll (pointercancel) cancels. */
export function armWarm(a: HTMLElement, conn?: { saveData?: boolean; effectiveType?: string }, delay = 100): void {
  const urls = warmUrls(a.dataset.warm);
  if (!urls.length || slowConnection(conn)) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const go = () => {
    done = true;
    for (const href of urls) document.head.append(Object.assign(document.createElement("link"), { rel: "modulepreload", href }));
  };
  const start = () => { if (!done && t === undefined) t = setTimeout(go, delay); };
  const stop = () => { clearTimeout(t); t = undefined; };
  a.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") start(); });
  a.addEventListener("pointerdown", start);
  a.addEventListener("focus", () => { if (a.matches(":focus-visible")) start(); });
  for (const ev of ["pointerleave", "pointercancel", "blur"]) a.addEventListener(ev, stop);
}
