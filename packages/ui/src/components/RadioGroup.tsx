import { useId } from "react";
import { cx } from "../lib/cx";

export type RadioOption = { label: string; value: string; hint?: string };

export function RadioGroup({ name, legend, options, value, onChange, className }: {
  name: string; legend: string; options: RadioOption[];
  value: string; onChange: (v: string) => void; className?: string;
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
