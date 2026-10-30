import { useEffect, useState } from "react";
import { Modal, ConfirmDialog } from "@meowerse/ui";
import { getPrivacy, setPrivacy, deleteAccount } from "../lib/chat";
import { clearLocalPush } from "../lib/push";
import { accountUrl } from "../lib/accountUrl";
import NotificationsSetting from "./NotificationsSetting";

/**
 * The account-settings modal. Slice 7 added the auto-group-add privacy toggle.
 * Slice 9 adds: a "notifications" toggle (requests permission ONLY on this explicit
 * tap — never auto-prompts) and a "danger zone" to delete the caller's meowsenger
 * data (type-to-confirm via @meowerse/ui ConfirmDialog → clears the session → redirect
 * home). The auth account is separate and unaffected. Reuses the @meowerse/ui Modal.
 */
export default function Settings({ base, open, onClose, userId }: { base: string; open: boolean; onClose: () => void; userId?: string }) {
  const [allow, setAllow] = useState<boolean | null>(null); // null = loading
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Slice 9 — the type-to-confirm delete dialog + its in-flight/error state.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Load the current preference each time the modal opens (and reset transient state).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAllow(null); setErr(null); setDeleteErr(null);
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

  // Slice 9 — delete the caller's meowsenger data, then (on success) redirect home.
  // The session cookie is cleared server-side, so "/" lands logged-out.
  async function onConfirmDelete() {
    setDeleting(true); setDeleteErr(null);
    const r = await deleteAccount(base);
    if (r.ok) {
      await clearLocalPush().catch(() => {}); // the account's server rows are gone; drop the device side
      if (typeof window !== "undefined") window.location.href = "/";
      return; // navigating away — leave the dialog in its loading state
    }
    setDeleting(false);
    setDeleteErr("couldn't delete — try again");
  }

  return (
    <>
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

        <NotificationsSetting base={base} userId={userId} open={open} />

        {/* Slice 9 — danger zone: delete the caller's meowsenger data. */}
        <div className="mw-danger">
          <span className="mw-danger__title">danger zone</span>
          <div className="mw-setting">
            <div className="mw-setting__text">
              <span className="mw-setting__label">delete my meowsenger data</span>
              <span className="mw-setting__hint mw-muted">
                removes your meowsenger memberships and profile and logs you out. your auth account
                (login, other apps) is separate and stays — manage it from account settings.
              </span>
            </div>
            <button
              type="button"
              className="mw-btn mw-btn--sm mw-danger__btn"
              onClick={() => setConfirmDelete(true)}
            >delete</button>
          </div>
          {deleteErr && <p className="mw-chat__err" role="alert">{deleteErr}</p>}
        </div>

        {/* /app renders without the site footer, so the legal pages are linked here. */}
        <nav className="mw-settings__links mw-muted" aria-label="about meowsenger">
          <a href="/privacy">privacy</a>
          <a href="/terms">terms</a>
          <a href="/about">about</a>
          <a href={accountUrl()}>meowerse account</a>
        </nav>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="delete my meowsenger data"
        description="this removes you from all your chats and erases your meowsenger profile, then logs you out. a group you own passes to an admin, or else its oldest member, and is deleted only if no one is left. messages you sent stay. it can't be undone. your auth account stays."
        confirmPhrase="delete"
        confirmLabel="delete my data"
        variant="danger"
        loading={deleting}
        onCancel={() => { if (!deleting) setConfirmDelete(false); }}
        onConfirm={() => void onConfirmDelete()}
      />
    </>
  );
}
