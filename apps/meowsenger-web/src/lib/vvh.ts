// Keeps --vvh equal to the visual viewport height so the app shell shrinks above the iOS
// on-screen keyboard (iOS ignores interactive-widget). CSS falls back to 100dvh when unset.
export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const set = () => document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height * vv.scale)}px`);
  vv.addEventListener("resize", set);
  vv.addEventListener("scroll", () => { if (vv.scale <= 1 && vv.offsetTop > 0) window.scrollTo(0, 0); });
  set();
}
