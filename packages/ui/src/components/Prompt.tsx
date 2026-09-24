import { forwardRef, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type PromptProps = {
  label: string; placeholder?: string; value: string; onChange: (v: string) => void;
  onSubmit: (v: string) => void; sendLabel?: string; maxRows?: number; busy?: boolean;
  enterSends?: "auto" | "always" | "never"; className?: string;
};

const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

export const Prompt = forwardRef<HTMLTextAreaElement, PromptProps>(function Prompt(
  { label, placeholder, value, onChange, onSubmit, sendLabel = "send", maxRows = 6, busy = false, enterSends = "auto", className }, ref) {
  const id = useId();
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const empty = value.trim() === "";

  useLayoutEffect(() => {                         // auto-grow up to maxRows, then scroll
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, lh * maxRows + 16)}px`;
  }, [value, maxRows]);

  const send = () => { if (!empty) onSubmit(value.trim()); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const sends = enterSends === "always" || (enterSends === "auto" && !coarse());
    if (!sends) return;
    e.preventDefault();
    send();
  };

  return (
    <div className={cx("mw-prompt", busy && "is-busy", className)}>
      <span className="mw-prompt__glyph" aria-hidden="true">›</span>
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea id={id} rows={1} value={value} placeholder={placeholder ?? label}
        ref={(el) => { inner.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        enterKeyHint="send" autoComplete="off" aria-busy={busy || undefined} />
      <button type="button" className="mw-prompt__send" aria-label={sendLabel}
        aria-disabled={empty || undefined} onClick={send}>
        <Icon name="send" size={20} />
      </button>
    </div>
  );
});
