import { Button } from "./Button";
import { cx } from "../lib/cx";

/** a grid of one-time recovery codes with a "copy all" button. */
export function RecoveryCodes({ codes, className }: {
  /** the codes to show, exactly as issued. */
  codes: string[];
  /** extra class names to append. */
  className?: string;
}) {
  const joined = codes.join("\n");
  async function copyAll() { try { await navigator.clipboard.writeText(joined); } catch {} }
  return (
    <div className={cx("mw-recovery", className)}>
      {codes.length > 0 && (
        <ul className="mw-recovery__grid">
          {/* by position: the list never reorders, and a repeated code must not collide as a key */}
          {codes.map((c, i) => <li key={i} className="mono" data-case="preserve">{c}</li>)}
        </ul>
      )}
      <div className="mw-recovery__actions">
        <Button size="sm" variant="secondary" disabled={codes.length === 0} onClick={copyAll}>copy all</Button>
      </div>
    </div>
  );
}
