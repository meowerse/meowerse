import { AppHeader, useSession } from "@meowerse/ui";
import { isPrefetchable } from "../lib/prefetch";

export default function SiteHeader({ base }: { base: string }) {
  const session = useSession(base);
  return <AppHeader session={session} prefetch={isPrefetchable} />;
}
