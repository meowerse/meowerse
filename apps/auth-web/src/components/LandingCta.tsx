import { useSession, Button } from "@meowerse/ui";

export default function LandingCta({ base }: { base: string }) {
  const s = useSession(base);
  // Optimistic: show the guest CTA immediately (no spinner) — the common case —
  // and swap to "go to account" only once a session actually resolves.
  if (!s.loading && s.authenticated) {
    return <a href="/account"><Button variant="primary">go to your account</Button></a>;
  }
  return (
    <div style={{ display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" }}>
      <a href="/signup"><Button variant="primary">create account</Button></a>
      <a href="/login"><Button variant="secondary">sign in</Button></a>
    </div>
  );
}
