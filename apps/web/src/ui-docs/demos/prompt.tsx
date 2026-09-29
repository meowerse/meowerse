import { useRef, useState } from "react";
import { Prompt } from "@meowerse/ui";

type Msg = { id: number; text: string; own: boolean };

// A tiny composer: sends land in the log below, exactly as typed. Nothing leaves the page.
export default function Demo() {
  const [value, setValue] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 1, text: "are we still on for tonight?", own: false }]);
  const seq = useRef(1);
  return (
    <div className="demo chat">
      <ol className="chat__log" aria-label="messages" aria-live="polite">
        {msgs.map((m) => <li key={m.id} className={m.own ? "bubble bubble--own" : "bubble"}>{m.text}</li>)}
      </ol>
      <Prompt label="message" value={value} onChange={setValue}
        onSubmit={(text) => { seq.current += 1; const id = seq.current; setMsgs((ms) => [...ms, { id, text, own: true }]); setValue(""); }} />
      <p className="mw-muted">Nothing leaves this page: messages stay in this demo.</p>
    </div>
  );
}
