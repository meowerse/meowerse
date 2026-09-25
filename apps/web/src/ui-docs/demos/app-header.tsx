import { useState } from "react";
import { AppHeader, RadioGroup, type Session } from "@meowerse/ui";

const SESSIONS: Record<string, Session> = {
  loading: { loading: true, authenticated: false },
  guest: { loading: false, authenticated: false },
  "signed-in": { loading: false, authenticated: true, username: "alxnko", verified: true },
  error: { loading: false, authenticated: false, error: "timeout" },
};

// AppHeader's default links point at the auth app (/login, /signup, /account, …), which 404 on
// meow.alxnko.dev: the strict link check has no exemptions, so this demo passes links that resolve
// on this site instead (same pattern as the static preview on this component's own page).
const DEMO_LINKS = {
  guest: [
    { label: "about", href: "/ui/" },
    { label: "developers", href: "/ui/components/" },
    { label: "docs", href: "/ui/" },
  ],
  guestActions: [
    { label: "log in", href: "/#projects" },
    { label: "sign up", href: "/#projects" },
  ],
  signedIn: [
    { label: "account", href: "/" },
    { label: "developers", href: "/ui/components/" },
    { label: "docs", href: "/ui/" },
  ],
};

export default function Demo() {
  const [k, setK] = useState("guest");
  return (
    <div className="demo">
      <RadioGroup name="demo-session" legend="session" value={k} onChange={setK} options={[
        { label: "checking", value: "loading" }, { label: "signed out", value: "guest" },
        { label: "signed in", value: "signed-in" }, { label: "check failed", value: "error" },
      ]} />
      <div className="demo__frame"><AppHeader session={SESSIONS[k]!} links={DEMO_LINKS} /></div>
    </div>
  );
}
