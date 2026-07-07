import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The 6 quick-reaction emojis offered by the picker (Slice 9). */
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

/**
 * A tiny emoji-picker popover (Slice 9) anchored near the pointer — opened from a
 * message's context-menu "react" item or its hover 😀 button. Shows the six common
 * reactions in a row; clicking one calls `onPick(emoji)` and closes. Clamped to the
 * viewport, dismissed on outside-click / Escape, mirroring MessageMenu's behaviour.
 */
export function EmojiPicker({
  x,
  y,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Clamp inside the viewport once measured (the picker is wider than it is tall).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(x - width / 2, window.innerWidth - width - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - height - pad));
    setPos({ left, top });
  }, [x, y]);

  // Focus the first emoji on open (keyboard accessibility).
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
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
      className="mw-card mw-emojipick"
      role="menu"
      aria-label="react with an emoji"
      style={{ left: pos.left, top: pos.top }}
    >
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="menuitem"
          className="mw-emojipick__btn"
          aria-label={`react ${emoji}`}
          onClick={() => { onPick(emoji); onClose(); }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
