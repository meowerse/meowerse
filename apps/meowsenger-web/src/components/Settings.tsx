import { useEffect, useState } from "react";
import { Modal } from "@meowerse/ui";
import { getPrivacy, setPrivacy } from "../lib/chat";

/**
 * The account-settings modal (Slice 7). One control for now: the auto-group-add
 * privacy toggle (`allow_auto_group_add`). When ON (the default), others can add
 * the caller to groups directly; when OFF, an add hands the actor an invite link
 * instead of adding them. Opened from the header menu; the toggle is optimistic and
 * reverts on a server error. Reuses the @meowerse/ui Modal (backdrop + focus-trap +
 * Escape).
 */
export default function Settings({ base, open, onClose }: { base: string; open: boolean; onClose: () => void }) {
  const [allow, setAllow] = useState<boolean | null>(null); // null = loading
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load the current preference each time the modal opens (and reset transient state).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAllow(null); setErr(null);
    getPrivacy(base).then((p) => { if (!cancelled) setAllow(p.allowAutoGroupAdd); });
    return () => { cancelled = true; };
  }, [open, base]);

  async function toggle() {
    if (saving || allow === null) return;
    const next = !allow;
    setAllow(next); setSaving(true); setErr(null); // optimistic
    const r = await setPrivacy(base, next);
    setSaving(false);
    if (r.error) { setAllow(!next); setErr("couldn't save — try again"); } // revert
  }

  return (
    <Modal open={open} onClose={onClose} title="settings" className="mw-settings">
      <div className="mw-setting">
        <div className="mw-setting__text">
          <span className="mw-setting__label">let people add me to groups directly</span>
          <span className="mw-setting__hint mw-muted">
            when off, anyone adding you sends an invite link instead — you decide whether to join.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allow === true}
          className={`mw-switch${allow ? " is-on" : ""}`}
          onClick={toggle}
          disabled={allow === null || saving}
          aria-label="let people add me to groups directly"
        >
          <span className="mw-switch__knob" aria-hidden="true" />
        </button>
      </div>
      {err && <p className="mw-chat__err" role="alert">{err}</p>}
    </Modal>
  );
}
