import type { ReactNode } from "react";
import { cx } from "../lib/cx";
/** the state a StatusLine shows: ok, wait, fail or info. */
export type StatusState = "ok" | "wait" | "fail" | "info";
/** exported so DOM code that keeps a server-rendered StatusLine in sync without React
 *  (apps/web/src/lib/status-dom.ts) imports this tag map instead of copying it. */
export const STATUS_TAGS: Record<StatusState, string> = { ok: "[ ok ]", wait: "[wait]", fail: "[fail]", info: "[info]" };
const TAG = STATUS_TAGS;
/** one line of state with a glyph and a word: [ ok ], [wait], [fail] or [info]. */
export function StatusLine({ state, children, live = false, action, className }: {
  /** the state to show; fail renders as an alert. */
  state: StatusState;
  /** the status text. */
  children: ReactNode;
  /** announces the non-fail states as a polite live region too. */
  live?: boolean;
  /** an action shown after the text, e.g. a retry button. */
  action?: ReactNode;
  /** extra class names to append. */
  className?: string;
}) {
  const role = state === "fail" ? "alert" : live ? "status" : undefined;
  return (
    <p className={cx("mw-status", `mw-status--${state}`, className)} role={role}>
      <span className="mw-status__tag" aria-hidden="true">{TAG[state]}</span>
      <span className="sr-only">{state === "ok" ? "ok" : state === "wait" ? "working" : state === "fail" ? "error" : "info"}: </span>
      <span className="mw-status__text">{children}</span>
      {action && <span className="mw-status__action">{action}</span>}
    </p>
  );
}
