import { useEffect, useState } from "react";

export type Session =
  | { loading: true; authenticated: false }
  | { loading: false; authenticated: false }
  | { loading: false; authenticated: true; username: string; verified: boolean };

export function useSession(base: string): Session {
  const [s, setS] = useState<Session>({ loading: true, authenticated: false });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`${base}/api/session`, { credentials: "include" });
        const j = (await res.json()) as { authenticated?: boolean; username?: string; verified?: boolean };
        if (!live) return;
        setS(j.authenticated && j.username
          ? { loading: false, authenticated: true, username: j.username, verified: !!j.verified }
          : { loading: false, authenticated: false });
      } catch {
        if (live) setS({ loading: false, authenticated: false });
      }
    })();
    return () => { live = false; };
  }, [base]);
  return s;
}
