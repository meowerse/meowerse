import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@meowerse/ui";

export interface MenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
}

/**
 * A small `mw-card` popover anchored near the pointer (right-click / long-press /
 * the ⋯ button). Closes on outside-click, Escape, or after an action. Items are
 * real buttons so they're keyboard-focusable; Escape returns focus to the trigger.
 */
export function MessageMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Clamp the popover inside the viewport once we know its measured size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - width - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
    setPos({ left, top });
  }, [x, y]);

  // Focus the first item on open, and restore focus to the trigger on close
  // (keyboard accessibility — mirrors packages/ui Modal).
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { restore?.focus?.(); };
  }, []);

  // Close on outside pointerdown or Escape.
  useEffect(() => {
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="mw-card mw-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="mw-menu__item"
          onClick={() => { it.onClick(); onClose(); }}
        >
          {it.icon && <Icon name={it.icon} size={15} className="mw-menu__icon" />}
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
