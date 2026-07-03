import { useSession, Spinner } from "@meowerse/ui";
import DevMarketing from "./DevMarketing";
import DashboardPage from "./DashboardPage";

export default function DevelopersPage({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <div className="mw-stack"><Spinner label="loading" /></div>;
  if (!s.authenticated) return <DevMarketing />;
  return <DashboardPage base={base} />;
}
