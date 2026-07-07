import { useState } from "react";

/** Message composer: a text input + send button. Enter sends; the input clears
 *  on send. Disabled until the socket is connected. */
export function Composer({ onSend, disabled }: { onSend: (body: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");

  function send() {
    const body = text.trim();
    if (!body || disabled) return;
    onSend(body);
    setText("");
  }

  return (
    <div className="mw-composer">
      <input
        type="text"
        value={text}
        placeholder="type a message…"
        aria-label="message"
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
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
  );
}
