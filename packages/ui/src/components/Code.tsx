import { useState } from "react";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export function Code({ value, copy = false, className }:
  { value: string; copy?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  async function onCopy() {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch {}
  }
  return (
    <span className={cx("mw-code", className)}>
      <code className="mono" data-case="preserve">{value}</code>
      {copy && (
        <button type="button" className="mw-code__copy" aria-label="copy" onClick={onCopy}>
          <Icon name={done ? "check" : "copy"} size={15} />
        </button>
      )}
    </span>
  );
}
