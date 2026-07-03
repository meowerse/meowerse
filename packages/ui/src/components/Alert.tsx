import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

const ICON = { error: "alert-triangle", success: "circle-check", info: "info-circle" } as const;

export function Alert({ variant = "info", onDismiss, children, className }: {
  variant?: "error" | "success" | "info"; onDismiss?: () => void; children: ReactNode; className?: string;
}) {
  return (
    <div role={variant === "error" ? "alert" : "status"} className={cx("mw-alert", `mw-alert--${variant}`, className)}>
      <Icon name={ICON[variant]} size={17} className="mw-alert__icon" />
      <span className="mw-alert__body">{children}</span>
      {onDismiss && (
        <button type="button" className="mw-alert__x" aria-label="dismiss" onClick={onDismiss}>
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}
