import { useEffect, useState } from "react";
import { listMeows, createMeow, type Meow } from "../lib/api";

export default function MeowList({ base, token }: { base: string; token: string }) {
  const [meows, setMeows] = useState<Meow[]>([]);
  const [text, setText] = useState("");
  useEffect(() => {
    listMeows(base, token).then(setMeows).catch(() => {});
  }, [base, token]);
  async function add() {
    if (!text.trim()) return;
    const m = await createMeow(base, token, text);
    setMeows((prev) => [m, ...prev]);
    setText("");
  }
  return (
    <div>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="meow..." />
      <button onClick={add}>add</button>
      <ul>
        {meows.map((m) => (
          <li key={m.id}>
            {m.text} <code>{m.slug}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
