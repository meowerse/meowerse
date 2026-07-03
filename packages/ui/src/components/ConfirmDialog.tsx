import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Field } from "./Field";

export type ConfirmResult = { password?: string };

export function ConfirmDialog({
  open, onCancel, onConfirm, title, description, confirmLabel,
  variant = "danger", confirmPhrase, requirePassword = false, loading = false,
}: {
  open: boolean; onCancel: () => void; onConfirm: (r: ConfirmResult) => void;
  title: string; description: string; confirmLabel: string;
  variant?: "danger" | "primary"; confirmPhrase?: string; requirePassword?: boolean; loading?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [pw, setPw] = useState("");
  // Reset when closed so a cancelled destructive dialog never reopens pre-armed.
  useEffect(() => { if (!open) { setTyped(""); setPw(""); } }, [open]);
  const phraseOk = !confirmPhrase || typed === confirmPhrase;
  const pwOk = !requirePassword || pw.length > 0;
  const canConfirm = phraseOk && pwOk && !loading;
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="mw-confirm__desc">{description}</p>
      {confirmPhrase && (
        <Field label={`type ${confirmPhrase} to confirm`} value={typed}
          onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
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
