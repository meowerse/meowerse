import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx";
import { Spinner } from "./Spinner";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, disabled, className, children, ...rest }, ref) {
  return (
    <button ref={ref} disabled={disabled || loading}
      className={cx("mw-btn", `mw-btn--${variant}`, `mw-btn--${size}`, loading && "mw-btn--loading", className)}
      {...rest}>
      {loading && <Spinner size="sm" label="working" />}
      <span>{children}</span>
    </button>
  );
});
