import { useRef, useState } from "react";
import { tgStart, tgStatus, nextLocation, type NextStep } from "../lib/authApi";

/** "Continue with Telegram" via the bot deep-link: start a ticket, open the bot, poll until linked. */
export default function TelegramButton({ base }: { base: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    setError("");
    const res = await tgStart(base).catch(() => ({ error: "network" }) as { error: string });
    if (!("deepLink" in res) || !res.deepLink || !res.ticketId) {
      setError("Telegram sign-in isn’t available right now.");
      return;
    }
    setLink(res.deepLink);
    const ticketId = res.ticketId;
    timer.current = setInterval(async () => {
      const s = await tgStatus(base, ticketId).catch(() => ({ ready: false }) as { ready: boolean; next?: NextStep });
      if (s.ready) {
        if (timer.current) clearInterval(timer.current);
        window.location.href = nextLocation(s.next);
      }
    }, 2000);
    setTimeout(() => timer.current && clearInterval(timer.current), 5 * 60 * 1000);
  }

  if (link) {
    return (
      <div>
        <a href={link} target="_blank" rel="noreferrer noopener"><button>Open Telegram to confirm</button></a>
        <p className="muted">Waiting for you to tap Start in Telegram…</p>
      </div>
    );
  }
  return (
    <>
      <button onClick={start} className="secondary">Continue with Telegram</button>
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}
