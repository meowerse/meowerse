import { useEffect, type ReactNode } from "react";
import { useSession } from "../lib/useSession";
import { Spinner } from "./Spinner";
import { Button } from "./Button";

export function AuthGate({ base, children, loginPath = "/login" }:
  { base: string; children: ReactNode; loginPath?: string }) {
  const s = useSession(base);
  const signedOut = !s.loading && !s.authenticated && !s.error;
  useEffect(() => {
    if (signedOut) {
      const next = encodeURIComponent(window.location.pathname + (window.location.search ?? ""));
      window.location.replace(`${loginPath}?next=${next}`);
    }
  }, [signedOut, loginPath]);

  if (!s.loading && !s.authenticated && s.error) {
    return (
      <div className="mw-gate mw-gate--error">
        <p className="mw-status mw-status--fail" role="alert">
          <span className="mw-status__tag" aria-hidden="true">[fail]</span>
          {s.error === "timeout"
            ? "the account service is taking too long."
            : s.error === "network"
              ? "can't reach the account service."
              : "the account service had a problem."}
        </p>
        <Button variant="secondary" onClick={s.retry}>try again</Button>
      </div>
    );
  }
  if (s.loading || !s.authenticated) {
    return <div className="mw-gate"><Spinner size="lg" label="checking your session" /></div>;
  }
  return <>{children}</>;
}
