// A prerendered page runs its scripts before the visitor is on it. Anything with an effect outside the
// page (network, WebGL, timers that show errors, …) goes through here: it runs at once on a normal load,
// and on `prerenderingchange` (the moment the visitor actually navigates to it) when prerendered.
export function afterActivation(fn: () => void, doc: Document = document): void {
  if ((doc as Document & { prerendering?: boolean }).prerendering) doc.addEventListener("prerenderingchange", () => fn(), { once: true });
  else fn();
}
