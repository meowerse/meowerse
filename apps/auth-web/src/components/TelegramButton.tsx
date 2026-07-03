import { useRef, useState } from "react";
import { Button } from "@meowerse/ui";
import { tgStart, tgStatus, nextLocation, type NextStep } from "../lib/authApi";

export default function TelegramButton({ base, kind, label }: { base: string; kind?: "VERIFY_EXISTING"; label?: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    setError("");
    const res = await tgStart(base, kind).catch(() => ({ error: "network" }) as { error: string });
    if (!("deepLink" in res) || !res.deepLink || !res.ticketId) { setError("telegram sign-in isn't available right now."); return; }
    setLink(res.deepLink);
    const ticketId = res.ticketId;
    timer.current = setInterval(async () => {
      const s = await tgStatus(base, ticketId).catch(() => ({ ready: false }) as { ready: boolean; next?: NextStep });
      if (s.ready) { if (timer.current) clearInterval(timer.current); window.location.href = nextLocation(s.next); }
    }, 2000);
    setTimeout(() => timer.current && clearInterval(timer.current), 5 * 60 * 1000);
  }

  if (link) {
    return (
      <div className="mw-stack">
        <a href={link} target="_blank" rel="noreferrer noopener"><Button variant="primary">open telegram to confirm</Button></a>
        <p className="mw-muted">waiting for you to tap start in telegram…</p>
      </div>
    );
  }
  return (
    <div className="mw-stack">
      <Button variant="secondary" onClick={start}>{label ?? "continue with telegram"}</Button>
      {error && <p role="alert" style={{ color: "var(--text-danger)" }}>{error}</p>}
    </div>
  );
}
