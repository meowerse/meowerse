import { AuthGate } from "@meowerse/ui";

// Points at a static file that isn't an account service (public/ui-demo/no-account/api/session), so the
// session check fails honestly, and without a network error, and the gate shows its error state.
export default function Demo() {
  return (
    <div className="demo__frame">
      <AuthGate base="/ui-demo/no-account"><p>account settings</p></AuthGate>
    </div>
  );
}
