import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export function Badge({ variant = "neutral", icon, children, className }: {
  variant?: "verified" | "neutral" | "danger"; icon?: string; children: ReactNode; className?: string;
}) {
  return (
    <span className={cx("mw-badge", `mw-badge--${variant}`, className)}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}
