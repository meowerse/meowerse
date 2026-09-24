import type { ReactNode } from "react";
import { cx } from "../lib/cx";
export type StatusState = "ok" | "wait" | "fail" | "info";
const TAG: Record<StatusState, string> = { ok: "[ ok ]", wait: "[wait]", fail: "[fail]", info: "[info]" };
export function StatusLine({ state, children, live = false, action, className }:
  { state: StatusState; children: ReactNode; live?: boolean; action?: ReactNode; className?: string }) {
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
