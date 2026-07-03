import { useEffect, type ReactNode } from "react";
import { useSession } from "../lib/useSession";
import { Spinner } from "./Spinner";

export function AuthGate({ base, children, loginPath = "/login" }:
  { base: string; children: ReactNode; loginPath?: string }) {
  const s = useSession(base);
  useEffect(() => {
    if (!s.loading && !s.authenticated) {
      const next = encodeURIComponent(window.location.pathname);
      window.location.replace(`${loginPath}?next=${next}`);
    }
  }, [s, loginPath]);

  if (s.loading || !s.authenticated) {
    return <div className="mw-gate"><Spinner size="lg" label="checking your session" /></div>;
  }
  return <>{children}</>;
}
