import { useSession, Spinner, StatusLine, Button } from "@meowerse/ui";
import DevMarketing from "./DevMarketing";
import DashboardPage from "./DashboardPage";

export default function DevelopersPage({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <div className="mw-stack"><Spinner label="loading" /></div>;
  // A session-check error (network/timeout/server) is not the same as being signed
  // out — showing the guest marketing page here would hide a real problem from a
  // signed-in developer on a network blip (B9/B18). Mirrors AuthGate's error state.
  if (!s.authenticated && s.error) {
    return (
      <div className="mw-stack">
        <StatusLine state="fail">
          {s.error === "timeout"
            ? "the account service is taking too long."
            : s.error === "network"
              ? "can't reach the account service."
              : "the account service had a problem."}
        </StatusLine>
        <Button variant="secondary" onClick={s.retry}>try again</Button>
      </div>
    );
  }
  if (!s.authenticated) return <DevMarketing />;
  return <DashboardPage base={base} />;
}
