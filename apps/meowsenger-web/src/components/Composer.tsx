import { useEffect, useRef, useState } from "react";

const TYPING_IDLE_MS = 4000;

/** The message being replied to, surfaced as a dismissable chip above the input. */
export interface ReplyDraft {
  id: string;
  name: string;
  preview: string;
}

/** Message composer: a text input + send button. Enter sends; the input clears
 *  on send. Disabled until the socket is connected.
 *
 *  Typing signal: `onTyping(true)` fires on the first keystroke after idle, and
 *  `onTyping(false)` fires after ~4s of no typing, on send, or on blur. The timer
 *  resets on every keystroke so a steady typist stays "typing". The parent maps
 *  these edge signals to deduped WS frames — the Composer never spams.
 *
 *  Reply: when `replyTo` is set, a "replying to <name>: <preview>" chip shows above
 *  the input; sending includes its id and the parent clears the draft via `onSend`. */
export function Composer({
  onSend,
  onTyping,
  disabled,
  replyTo,
  onCancelReply,
}: {
  onSend: (body: string) => void;
  onTyping?: (active: boolean) => void;
  disabled?: boolean;
  replyTo?: ReplyDraft | null;
  onCancelReply?: () => void;
}) {
  const [text, setText] = useState("");
  const idleTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input when a reply is armed, so the user can type immediately.
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  function stopTyping() {
    if (idleTimer.current != null) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    onTyping?.(false);
  }

  // Belt-and-braces: if the component unmounts (chat switch) mid-type, tell the
  // parent to clear the typing state so a stale "on" isn't left dangling.
  useEffect(() => stopTyping, []); // eslint-disable-line react-hooks/exhaustive-deps

  function keystroke() {
    onTyping?.(true); // parent dedupes → one frame per idle→active edge
    if (idleTimer.current != null) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function send() {
    const body = text.trim();
    if (!body || disabled) return;
    onSend(body);
    setText("");
    stopTyping();
  }

  return (
    <div className="mw-composer">
      {replyTo && (
        <div className="mw-replybar">
          <span className="mw-replybar__text">
            <span className="mw-replybar__name" data-case="preserve">replying to {replyTo.name}</span>
            <span className="mw-replybar__preview">{replyTo.preview}</span>
          </span>
          <button
            type="button"
            className="mw-replybar__x"
            aria-label="cancel reply"
            onClick={() => { onCancelReply?.(); inputRef.current?.focus(); }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="mw-composer__row">
      <input
        ref={inputRef}
        type="text"
        value={text}
        placeholder="type a message…"
        aria-label="message"
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value) keystroke();
          else stopTyping();
        }}
        onBlur={stopTyping}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        className="mw-btn mw-btn--primary mw-btn--md"
        onClick={send}
        disabled={disabled || !text.trim()}
      >
        send
      </button>
      </div>
    </div>
  );
}
