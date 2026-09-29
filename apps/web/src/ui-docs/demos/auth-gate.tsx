import { useState } from "react";
import { AuthGate, RadioGroup, Spinner, clearSessionCache } from "@meowerse/ui";

// Each state points AuthGate at a static stand-in for the account service under public/ui-demo/, so
// the gate runs for real (fetch, parse, render) at no cost and never touches a real session:
// - signed in: ui-demo/signed-in/api/session is a session JSON in exactly the shape useSession reads.
//   (It's served without a JSON content type: fetch's .json() never looks at it, and it's same-origin.)
// - service error: ui-demo/no-account/api/session isn't JSON at all, so the check fails honestly (an
//   unreadable answer, not a network error) and the gate shows its error, whose "try again" re-checks.
// - checking: a static host can't hold a request open, so this one is a still of the gate's wait state:
//   the same markup AuthGate renders while it waits (an e2e test compares the two).
// Signed out isn't offered: on a real signed-out answer AuthGate leaves the page for loginPath.
const BASES = { "signed-in": "/ui-demo/signed-in", error: "/ui-demo/no-account" } as const;
const NOTES: Record<string, string> = {
  "signed-in": "the stand-in account service answers \"signed in\", so the gate shows what it wraps.",
  checking: "a still of the wait: a real check shows this until the account service answers (at most 8 s).",
  error: "a simulated failure: the stand-in answer isn't one the gate can read. \"try again\" checks again, and fails the same way.",
};

export default function Demo() {
  const [k, setK] = useState("signed-in");
  // useSession shares one cache and one in-flight check per page: drop both on a switch, so the next
  // gate asks its own stand-in instead of reusing the last one's answer.
  const pick = (v: string) => { clearSessionCache(); setK(v); };
  return (
    <div className="demo">
      <RadioGroup name="demo-gate" legend="account service answers" value={k} onChange={pick} options={[
        { label: "signed in", value: "signed-in" }, { label: "still checking", value: "checking" }, { label: "service error (simulated)", value: "error" },
      ]} />
      <p className="demo__out">{NOTES[k]}</p>
      <div className="demo__frame demo__frame--gate">
        {k === "checking"
          ? <div className="mw-gate"><Spinner size="lg" label="checking your session" /></div>
          : <AuthGate key={k} base={BASES[k as keyof typeof BASES]}><p>account settings</p></AuthGate>}
      </div>
      <p className="mw-muted">signed out isn't shown here: on a real signed-out answer the gate sends people to sign in (location.replace to loginPath), which would take you away from this page.</p>
    </div>
  );
}
