// "play" on the motion foundations page: toggles a class; the CSS transitions use the motion tokens,
// and prefers-reduced-motion makes them jump (ui global.css).
export function bindMotionDemos(doc: Document = document): void {
  for (const demo of doc.querySelectorAll<HTMLElement>("[data-motion-demo]")) {
    const btn = demo.querySelector<HTMLButtonElement>("[data-motion-play]");
    btn?.addEventListener("click", () => {
      const on = demo.classList.toggle("is-playing");
      btn.textContent = on ? "reset" : "play";
      btn.setAttribute("aria-pressed", String(on));
    });
  }
}
