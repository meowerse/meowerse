import { forwardRef, useCallback, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type PromptProps = {
  /** the label: visually hidden and repeated as the placeholder, unless labelPlacement is float. */
  label: string;
  /** where the label sits: hidden (the placeholder repeats it), or float — shown inside the empty field and
   *  moved up onto its top border once it is focused or filled, so it stays visible (CSS only). */
  labelPlacement?: "hidden" | "float";
  /** overrides the placeholder text shown while empty (with a floating label, only while focused). */
  placeholder?: string;
  /** the textarea's current value. */
  value: string;
  /** called with the new value on every keystroke. */
  onChange: (v: string) => void;
  /** called with the trimmed value when it is sent. */
  onSubmit: (v: string) => void;
  /** the send button's accessible name; a blank one falls back to "send". */
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
  { label, labelPlacement = "hidden", placeholder, value, onChange, onSubmit, sendLabel = "send", maxRows = 6, busy = false, enterSends = "auto", className }, ref) {
  const id = useId();
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const empty = value.trim() === "";
  const rows = maxRows >= 1 ? maxRows : 1;         // 0, a negative or NaN would collapse the field
  const float = labelPlacement === "float";

  useLayoutEffect(() => {                         // auto-grow up to maxRows, then scroll
    const el = inner.current;
    if (!el) return;
    el.style.height = "auto";
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
    el.style.height = `${Math.min(el.scrollHeight, lh * rows + 20)}px`;
  }, [value, rows]);

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
    <div className={cx("mw-prompt", float && "mw-prompt--float", busy && "is-busy", className)}>
      <span className="mw-prompt__glyph" aria-hidden="true">›</span>
      {!float && <label htmlFor={id} className="sr-only">{label}</label>}
      {/* float: the label follows the textarea so `textarea:placeholder-shown + label` places it with no JS;
          that needs a placeholder, so without one it is a single (invisible) space. */}
      <textarea id={id} rows={1} value={value}
        placeholder={float ? (placeholder?.trim() ? placeholder : " ") : placeholder ?? label}
        ref={setRefs}
        onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        enterKeyHint="send" autoComplete="off" aria-busy={busy || undefined} />
      {float && <label htmlFor={id} className="mw-prompt__float-label">{label}</label>}
      <button type="button" className="mw-prompt__send" aria-label={sendLabel.trim() || "send"}
        aria-disabled={empty || undefined} onClick={send}>
        <Icon name="send" size={20} />
      </button>
    </div>
  );
});
