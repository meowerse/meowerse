// Containment for the playground's preview only: a component that throws on some combination of props
// shows a plain inline error in the stage (B9) while the controls stay live, instead of React unmounting
// the whole island (controls included) and leaving an empty page. It clears itself whenever `resetKey`
// (the serialised state) changes, so fixing the input brings the preview straight back — reset on a
// change rather than keyed on it, so a working preview isn't remounted on every keystroke.
import { Component, useState, type ReactNode } from "react";
import { StatusLine } from "@meowerse/ui";

type CatchProps = { resetKey: string; onError: (e: Error | null) => void; children: ReactNode };
type CatchState = { failed: boolean; key: string };

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** The boundary proper. It renders nothing once it has caught, and reports up instead: React remounts a
 *  boundary's own output after every catch, so an error line rendered here would be a new role=alert
 *  on each keystroke typed through a broken state — re-announced every time. */
class Catch extends Component<CatchProps, CatchState> {
  state: CatchState = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<CatchState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: CatchProps, state: CatchState): Partial<CatchState> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(asError(error));
  }

  componentDidUpdate(prev: CatchProps) {
    if (!this.state.failed && prev.resetKey !== this.props.resetKey) this.props.onError(null);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function PreviewBoundary({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const [error, setError] = useState<Error | null>(null);
  return (
    <>
      <Catch resetKey={resetKey} onError={setError}>{children}</Catch>
      {/* pg__error tells this line apart from a previewed StatusLine in `fail` (tests select on it).
          StatusLine `fail` is its own role=alert, announced when it appears; nothing else in the stage is
          a live region. While the state keeps throwing it stays mounted and only its message updates. */}
      {error && (
        <StatusLine state="fail" className="pg__error">
          this combination of props can't render. change a control to try again. <code className="mono" data-case="preserve">{error.message}</code>
        </StatusLine>
      )}
    </>
  );
}
