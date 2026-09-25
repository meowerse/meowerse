import { useId } from "react";
import { cx } from "../lib/cx";

/** one choice in a RadioGroup. */
export type RadioOption = { label: string; value: string; hint?: string };

/** a labelled group of native radio buttons, each in a 44 px row, with optional hints. */
export function RadioGroup({ name, legend, options, value, onChange, className }: {
  /** the shared name of the underlying radio inputs. */
  name: string;
  /** the group's fieldset legend. */
  legend: string;
  /** the choices to offer. */
  options: RadioOption[];
  /** the currently selected option's value. */
  value: string;
  /** called with the newly selected option's value. */
  onChange: (v: string) => void;
  /** extra class names to append. */
  className?: string;
}) {
  const gid = useId();
  return (
    <fieldset className={cx("mw-radio", className)}>
      <legend>{legend}</legend>
      {options.map((o) => {
        const id = `${gid}-${o.value}`;
        return (
          <label key={o.value} htmlFor={id} className="mw-radio__opt">
            <input id={id} type="radio" name={name} value={o.value}
              checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}{o.hint && <em className="mw-radio__hint">{o.hint}</em>}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
