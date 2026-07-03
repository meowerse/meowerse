import { useSession, Button, Spinner } from "@meowerse/ui";

export default function LandingCta({ base }: { base: string }) {
  const s = useSession(base);
  if (s.loading) return <Spinner label="loading" />;
  if (s.authenticated) return <a href="/account"><Button variant="primary">go to your account</Button></a>;
  return (
    <div style={{ display: "flex", gap: "var(--gap-sm)" }}>
      <a href="/signup"><Button variant="primary">create account</Button></a>
      <a href="/login"><Button variant="secondary">sign in</Button></a>
    </div>
  );
}
