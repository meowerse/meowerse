import { useEffect, useId, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field } from "./Field";
import { cx } from "../lib/cx";

/** the password typed into a ConfirmDialog that requires one, if any. */
export type ConfirmResult = { password?: string };

/** a modal that asks before something destructive, optionally making you type a phrase or your password. */
export function ConfirmDialog({
  open, onCancel, onConfirm, title, description, confirmLabel,
  variant = "danger", confirmPhrase, requirePassword = false, loading = false,
}: {
  /** whether the dialog is open. */
  open: boolean;
  /** called when the dialog is cancelled (Escape, backdrop or the cancel button). */
  onCancel: () => void;
  /** called with the typed password (if requirePassword) once the confirm button is pressed and enabled. */
  onConfirm: (r: ConfirmResult) => void;
  /** the dialog's title. */
  title: string;
  /** explains what is about to happen. */
  description: string;
  /** the confirm button's label; name it after the action, e.g. "delete chat". */
  confirmLabel: string;
  /** the confirm button's tone. */
  variant?: "danger" | "primary";
  /** a phrase the person must type exactly before the confirm button enables. */
  confirmPhrase?: string;
  /** asks for the current password before the confirm button enables. */
  requirePassword?: boolean;
  /** disables the confirm button and shows it as busy while the action runs. */
  loading?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [pw, setPw] = useState("");
  const phraseId = useId();
  // Reset when closed so a cancelled destructive dialog never reopens pre-armed.
  useEffect(() => { if (!open) { setTyped(""); setPw(""); } }, [open]);
  const phraseOk = !confirmPhrase || typed === confirmPhrase;
  const pwOk = !requirePassword || pw.length > 0;
  const canConfirm = phraseOk && pwOk && !loading;
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="mw-confirm__desc">{description}</p>
      {confirmPhrase && (
        <div className="mw-confirm__phrase">
          <p id={`${phraseId}-lbl`}>to confirm, type <code>{confirmPhrase}</code></p>
          <Field label={`type ${confirmPhrase} to confirm`} className="mw-confirm__field" value={typed}
            onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="none"
            autoCorrect="off" spellCheck={false} data-case="preserve"
            aria-describedby={cx(`${phraseId}-lbl`, typed && !phraseOk && `${phraseId}-hint`)} />
          {typed && !phraseOk && <span id={`${phraseId}-hint`} className="mw-field__hint">doesn't match yet</span>}
        </div>
      )}
      {requirePassword && (
        <Field label="your password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      )}
      <div className="mw-confirm__actions">
        <Button variant="secondary" onClick={onCancel}>cancel</Button>
        <Button variant={variant} disabled={!canConfirm} loading={loading}
          onClick={() => onConfirm({ password: requirePassword ? pw : undefined })}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}
