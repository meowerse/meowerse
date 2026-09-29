import { forwardRef, useCallback, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type PromptProps = {
  /** the visually-hidden label, also used as the placeholder. */
  label: string;
  /** overrides the placeholder text shown while empty. */
  placeholder?: string;
  /** the textarea's current value. */
  value: string;
  /** called with the new value on every keystroke. */
  onChange: (v: string) => void;
  /** called with the trimmed value when it is sent. */
  onSubmit: (v: string) => void;
  /** the send button's accessible name. */
  sendLabel?: string;
  /** the tallest the textarea grows before it scrolls. */
  maxRows?: number;
  /** shows the composer as busy; the field stays editable so sends can queue. */
  busy?: boolean;
  /** whether Enter sends: auto only on non-touch pointers, always, or never (the button always sends). */
  enterSends?: "auto" | "always" | "never";
  /** extra class names to append. */
  className?: string;
};

const coarse = () => typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;

/** the chat composer: a › glyph before a normal, auto-growing textarea, with a visible send button. */
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
    el.style.height = `${Math.min(el.scrollHeight, lh * maxRows + 20)}px`;
  }, [value, maxRows]);

  const send = () => { if (!empty) onSubmit(value.trim()); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const sends = enterSends === "always" || (enterSends === "auto" && !coarse());
    if (!sends) return;
    e.preventDefault();
    send();
  };

  const setRefs = useCallback((el: HTMLTextAreaElement | null) => {
    inner.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  }, [ref]);

  return (
    <div className={cx("mw-prompt", busy && "is-busy", className)}>
      <span className="mw-prompt__glyph" aria-hidden="true">›</span>
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea id={id} rows={1} value={value} placeholder={placeholder ?? label}
        ref={setRefs}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        enterKeyHint="send" autoComplete="off" aria-busy={busy || undefined} />
      <button type="button" className="mw-prompt__send" aria-label={sendLabel}
        aria-disabled={empty || undefined} onClick={send}>
        <Icon name="send" size={20} />
      </button>
    </div>
  );
});
