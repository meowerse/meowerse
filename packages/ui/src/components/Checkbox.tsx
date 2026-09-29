import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cx } from "../lib/cx";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id"> & {
  /** the visible label; clicking it toggles the checkbox. */
  label: string;
};

/** a native checkbox with its label, in a 44 px row. */
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
