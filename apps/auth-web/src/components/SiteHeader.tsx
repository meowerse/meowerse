import { AppHeader, useSession } from "@meowerse/ui";

export default function SiteHeader({ base }: { base: string }) {
  const session = useSession(base);
  return <AppHeader session={session} />;
}
