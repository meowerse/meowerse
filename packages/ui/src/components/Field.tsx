import { forwardRef, useId, useState, type InputHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  /** the visible label, always shown and tied to the input. */
  label: string;
  /** helper text shown below the input, linked with aria-describedby. */
  hint?: string;
  /** an error message shown instead of the hint; also sets aria-invalid. */
  error?: string;
};

/** a labelled text input with an optional hint or error, and a reveal button for passwords. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, type = "text", className, ...rest }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [reveal, setReveal] = useState(false);
  const isPw = type === "password";
  // A blank hint or error is no hint or error: a whitespace-only error would otherwise mark the input
  // invalid with an alert that says nothing.
  const hasHint = !!hint?.trim();
  const hasError = !!error?.trim();
  const describedBy = cx(hasHint && hintId, hasError && `${id}-err`) || undefined;
  return (
    <div className={cx("mw-field", hasError && "mw-field--error", className)}>
      <label htmlFor={id}>{label}</label>
      <div className="mw-field__control">
        <input ref={ref} id={id} type={isPw && reveal ? "text" : type}
          aria-invalid={hasError ? true : undefined} aria-describedby={describedBy} {...rest} />
        {isPw && (
          <button type="button" className="mw-field__reveal"
            aria-label={reveal ? "hide password" : "show password"} onClick={() => setReveal((v) => !v)}>
            <Icon name={reveal ? "eye-off" : "eye"} size={17} />
          </button>
        )}
      </div>
      {hasHint && !hasError && <span id={hintId} className="mw-field__hint">{hint}</span>}
      {hasError && <span id={`${id}-err`} role="alert" className="mw-field__error">{error}</span>}
    </div>
  );
});
