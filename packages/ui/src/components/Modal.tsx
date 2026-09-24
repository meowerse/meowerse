import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";

const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
const usable = (el: HTMLElement) =>
  !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && el.tabIndex !== -1 && !el.closest("[inert]");

export function Modal({ open, onClose, title, children, className }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;                       // latest callback without re-running the effect

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const panel = panelRef.current!;
    const list = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable);
    (panel.querySelector<HTMLElement>("[data-autofocus]") ?? list()[0] ?? panel).focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = list();
      const first = f[0], last = f[f.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); restore?.focus?.(); };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="mw-modal">
      <div className="mw-modal__backdrop" data-testid="mw-modal-backdrop" onClick={() => closeRef.current()} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
        className={cx("mw-modal__panel", className)}>
        <h2 id={id} className="mw-modal__title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
