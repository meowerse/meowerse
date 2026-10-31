import { useEffect, useRef, useState } from "react";
import { Icon } from "@meowerse/ui";
import { enterSubmits } from "../lib/enterKey";
import type { SendResult } from "../hooks/useConversation";

const TYPING_IDLE_MS = 4000;
/** The server's body limit; also the textarea's `maxLength`. */
const MAX_LEN = 4000;
/** The counter appears (and is announced) once this few characters remain. */
const COUNT_FROM = 400;

/** The message being replied to, surfaced as a dismissable chip above the input. */
export interface ReplyDraft {
  id: string;
  name: string;
  preview: string;
}

/** Message composer: a text input + send button. Enter sends on desktop (a newline
 *  on touch devices); IME composition never sends. The textarea is NEVER disabled --
 *  while the socket isn't open the parent queues the message (in memory) and the text
 *  clears only when `onSend` reports "sent" or "queued"; "rejected" keeps it.
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
  replyTo,
  onCancelReply,
  onDraftChange,
}: {
  onSend: (body: string) => SendResult;
  onTyping?: (active: boolean) => void;
  replyTo?: ReplyDraft | null;
  onCancelReply?: () => void;
  /** Mirrors the unsent text to the parent (memory only) so a session-ended banner can hand it back. */
  onDraftChange?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const draftCb = useRef(onDraftChange);
  draftCb.current = onDraftChange;
  useEffect(() => { draftCb.current?.(text); }, [text]);
  useEffect(() => () => draftCb.current?.(""), []);
  const idleTimer = useRef<number | null>(null);
  // A <textarea>, not <input>: browsers never run username/password autofill on a
  // textarea, so the mobile credentials/autofill strip (which ignores
  // autocomplete=off on an <input>) never attaches. It also gives free multi-line
  // composing (Shift+Enter). Matches the inline-edit field, which is already one.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the input when a reply is armed, so the user can type immediately.
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  // Auto-grow with the content, from one row up to a few, then scroll.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [text]);

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
    if (!body) return;
    if (onSend(body) === "rejected") return; // keep the text: nothing was sent or queued
    setText("");
    stopTyping();
  }

  const remaining = MAX_LEN - text.length;
  const enterHint = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches ? "enter" : "send";

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
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <div className="mw-composer__row">
      <textarea
        ref={inputRef}
        className="mw-composer__input"
        rows={1}
        autoComplete="off"
        autoCapitalize="sentences"
        enterKeyHint={enterHint}
        value={text}
        placeholder="type a message…"
        aria-label="message"
        maxLength={MAX_LEN}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value) keystroke();
          else stopTyping();
        }}
        onBlur={stopTyping}
        onKeyDown={(e) => {
          // Desktop Enter sends; Shift+Enter / touch Enter insert a newline; an open IME
          // composition (Enter confirms the candidate) never sends.
          if (enterSubmits(e)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button
        className="mw-btn mw-btn--primary mw-btn--md"
        aria-label="send"
        onClick={send}
        disabled={!text.trim()}
      >
        <span className="mw-tlabel">send</span>
        <span className="mw-ticon" aria-hidden="true"><Icon name="send" size={16} /></span>
      </button>
      </div>
      {remaining <= COUNT_FROM && (
        <span className={`mw-composer__count${remaining <= 0 ? " is-limit" : ""}`} aria-hidden="true">
          {text.length} / {MAX_LEN}
        </span>
      )}
      {/* Polite announcement that changes only when a threshold is crossed, so a steady
          typist is not read a number per keystroke. */}
      <span className="mw-sr-only" role="status" aria-live="polite">{countAnnouncement(remaining)}</span>
    </div>
  );
}

/** Coarse buckets, so the live region only updates near the limit. */
function countAnnouncement(remaining: number): string {
  if (remaining <= 0) return "message limit reached";
  if (remaining <= 20) return "20 characters left or fewer";
  if (remaining <= 100) return "100 characters left or fewer";
  if (remaining <= COUNT_FROM) return "400 characters left or fewer";
  return "";
}
