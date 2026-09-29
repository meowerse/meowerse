import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

/** a small label for a state or a category: verified, neutral or danger. */
export function Badge({ variant = "neutral", icon, children, className }: {
  /** the tone of the badge. */
  variant?: "verified" | "neutral" | "danger";
  /** a decorative icon name, shown before the label. */
  icon?: string;
  /** the label itself. */
  children: ReactNode;
  /** extra class names to append. */
  className?: string;
}) {
  return (
    <span className={cx("mw-badge", `mw-badge--${variant}`, className)}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}
