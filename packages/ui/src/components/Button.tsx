import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cx } from "../lib/cx";
import { Spinner } from "./Spinner";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** the button's tone; use primary for the one main action per view. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** the button's size; both keep a 44 px hit area. */
  size?: "sm" | "md";
  /** shows a spinner and disables the button. */
  loading?: boolean;
};

/** a native button in four variants and two sizes, with a loading state. */
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
