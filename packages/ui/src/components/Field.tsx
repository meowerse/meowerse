import { forwardRef, useId, useState, type InputHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string; hint?: string; error?: string;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, type = "text", className, ...rest }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [reveal, setReveal] = useState(false);
  const isPw = type === "password";
  const describedBy = cx(hint && hintId, error && `${id}-err`) || undefined;
  return (
    <div className={cx("mw-field", error && "mw-field--error", className)}>
      <label htmlFor={id}>{label}</label>
      <div className="mw-field__control">
        <input ref={ref} id={id} type={isPw && reveal ? "text" : type}
          aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
        {isPw && (
          <button type="button" className="mw-field__reveal"
            aria-label={reveal ? "hide password" : "show password"} onClick={() => setReveal((v) => !v)}>
            <Icon name={reveal ? "eye-off" : "eye"} size={17} />
          </button>
        )}
      </div>
      {hint && !error && <span id={hintId} className="mw-field__hint">{hint}</span>}
      {error && <span id={`${id}-err`} role="alert" className="mw-field__error">{error}</span>}
    </div>
  );
});
