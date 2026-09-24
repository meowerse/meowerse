import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";

const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

// jsdom (used by this component's tests) never runs layout, so every element's
// getClientRects() is permanently empty there — checking it unconditionally would
// treat every focusable control as hidden and break the tests. Detect a real
// layout engine once per check instead of guessing from the environment: a real
// browser always gives <html> a non-empty rect.
const hasLayout = () => document.documentElement.getClientRects().length > 0;

const usable = (el: HTMLElement) => {
  if (el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true" || el.tabIndex === -1) return false;
  if (el.closest("[inert]") || el.closest("[hidden]")) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (el.getClientRects && hasLayout() && el.getClientRects().length === 0) return false;
  return true;
};

// Module-level stack of open modals' ids, most-recently-opened last. Only the topmost
// modal should react to Tab/Escape, so nested modals (e.g. a ConfirmDialog over a Modal)
// don't fight over keydown.
const modalStack: string[] = [];

export function Modal({ open, onClose, title, children, className }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;                       // latest callback without re-running the effect

  useEffect(() => {
    if (!open) return;
    modalStack.push(id);
    const isTop = () => modalStack[modalStack.length - 1] === id;
    const restore = document.activeElement as HTMLElement | null;
    const panel = panelRef.current!;
    const list = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(usable);
    (panel.querySelector<HTMLElement>("[data-autofocus]") ?? list()[0] ?? panel).focus();

    function onKey(e: KeyboardEvent) {
      if (!isTop()) return;
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = list();
      const first = f[0], last = f[f.length - 1];
      if (!first || !last) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const idx = modalStack.lastIndexOf(id);
      if (idx !== -1) modalStack.splice(idx, 1);
      restore?.focus?.();
    };
  }, [open, id]);

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
