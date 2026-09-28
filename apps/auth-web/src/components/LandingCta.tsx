import { useSession, Button } from "@meowerse/ui";

export default function LandingCta({ base }: { base: string }) {
  const s = useSession(base);

  // While resolving, preserve the exact button dimensions with hidden buttons
  // so there is zero layout shift (CLS = 0) and guests/users don't see flashing wrong CTAs.
  if (s.loading) {
    return (
      <div style={{ display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap", minHeight: "2.5rem" }} aria-busy="true">
        <Button variant="primary" disabled style={{ visibility: "hidden" }}>create account</Button>
        <Button variant="secondary" disabled style={{ visibility: "hidden" }}>sign in</Button>
      </div>
    );
  }

  if (s.authenticated) {
    return <a href="/account"><Button variant="primary">go to your account</Button></a>;
  }

  return (
    <div style={{ display: "flex", gap: "var(--gap-sm)", flexWrap: "wrap" }}>
      <a href="/signup"><Button variant="primary">create account</Button></a>
      <a href="/login"><Button variant="secondary">sign in</Button></a>
    </div>
  );
}
