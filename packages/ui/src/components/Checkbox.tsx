import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cx } from "../lib/cx";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & { label: string };

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest }, ref) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx("mw-check", className)}>
      <input ref={ref} id={id} type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
});
