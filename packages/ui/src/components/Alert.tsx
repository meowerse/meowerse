import type { ReactNode } from "react";
import { cx } from "../lib/cx";

const ICON = { error: "alert-triangle", success: "circle-check", info: "info-circle" } as const;

export function Alert({ variant = "info", onDismiss, children, className }: {
  variant?: "error" | "success" | "info"; onDismiss?: () => void; children: ReactNode; className?: string;
}) {
  return (
    <div role={variant === "error" ? "alert" : "status"} className={cx("mw-alert", `mw-alert--${variant}`, className)}>
      <i className={`ti ti-${ICON[variant]}`} aria-hidden="true" />
      <span className="mw-alert__body">{children}</span>
      {onDismiss && (
        <button type="button" className="mw-alert__x" aria-label="dismiss" onClick={onDismiss}>
          <i className="ti ti-x" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
