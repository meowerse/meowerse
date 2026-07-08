import { useEffect, useState } from "react";
import { Modal, ConfirmDialog } from "@meowerse/ui";
import { getPrivacy, setPrivacy, deleteAccount } from "../lib/chat";
import { pushSupported, pushPermission, pushSubscribed, enablePush, disablePush } from "../lib/push";

/** Whether this browser can do Web Push at all (SSR-safe). */
function notificationsSupported(): boolean {
  return pushSupported();
}

/**
 * The account-settings modal. Slice 7 added the auto-group-add privacy toggle.
 * Slice 9 adds: a "notifications" toggle (requests permission ONLY on this explicit
 * tap — never auto-prompts) and a "danger zone" to delete the caller's meowsenger
 * data (type-to-confirm via @meowerse/ui ConfirmDialog → clears the session → redirect
 * home). The auth account is separate and unaffected. Reuses the @meowerse/ui Modal.
 */
export default function Settings({ base, open, onClose }: { base: string; open: boolean; onClose: () => void }) {
  const [allow, setAllow] = useState<boolean | null>(null); // null = loading
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Slice 9 — Notification.permission mirrored into state ("default" | "granted" |
  // "denied"), or null when the API is unavailable. Drives the notifications toggle.
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | null>(null);
  // Whether an active push subscription exists (drives on/off), + an in-flight flag.
  const [subscribed, setSubscribed] = useState(false);
  const [notifBusy, setNotifBusy] = useState(false);
  // Slice 9 — the type-to-confirm delete dialog + its in-flight/error state.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // Load the current preference each time the modal opens (and reset transient state).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAllow(null); setErr(null); setDeleteErr(null);
    const perm = pushPermission();
    setNotifPerm(perm === "unsupported" ? null : (perm as NotificationPermission));
    void pushSubscribed().then((s) => { if (!cancelled) setSubscribed(s); });
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

  // Enable Web Push: requests permission (ONLY on this explicit tap), registers the
  // service worker, and subscribes. Mirrors the resulting permission + subscribed
  // state. Turning it off unsubscribes locally + on the server.
  async function enableNotifications() {
    if (!notificationsSupported() || notifBusy) return;
    setNotifBusy(true);
    try {
      const result = await enablePush(base);
      if (result !== "unsupported") setNotifPerm(result as NotificationPermission);
      if (result === "granted") setSubscribed(true);
    } catch {
      setNotifPerm(pushPermission() as NotificationPermission);
    } finally {
      setNotifBusy(false);
    }
  }
  async function disableNotifications() {
    if (notifBusy) return;
    setNotifBusy(true);
    try { await disablePush(base); setSubscribed(false); } finally { setNotifBusy(false); }
  }

  // Slice 9 — delete the caller's meowsenger data, then (on success) redirect home.
  // The session cookie is cleared server-side, so "/" lands logged-out.
  async function onConfirmDelete() {
    setDeleting(true); setDeleteErr(null);
    const r = await deleteAccount(base);
    if (r.ok) {
      if (typeof window !== "undefined") window.location.href = "/";
      return; // navigating away — leave the dialog in its loading state
    }
    setDeleting(false);
    setDeleteErr("couldn't delete — try again");
  }

  const notifDenied = notifPerm === "denied";

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

        {/* Slice 9 — notifications. Only ever prompts on this explicit tap. */}
        {notificationsSupported() && (
          <div className="mw-setting">
            <div className="mw-setting__text">
              <span className="mw-setting__label">notify me of new messages</span>
              <span className="mw-setting__hint mw-muted">
                {notifDenied
                  ? "blocked in your browser — re-enable notifications for this site in site settings."
                  : "get a push notification for new messages even when meowsenger is closed. clicking it opens the chat."}
              </span>
            </div>
            {subscribed ? (
              <button
                type="button"
                className="mw-btn mw-btn--ghost mw-btn--sm"
                onClick={disableNotifications}
                disabled={notifBusy}
                aria-label="turn off notifications"
              >{notifBusy ? "…" : "on ✓ · turn off"}</button>
            ) : (
              <button
                type="button"
                className="mw-btn mw-btn--secondary mw-btn--sm"
                onClick={enableNotifications}
                disabled={notifDenied || notifBusy}
              >{notifBusy ? "…" : "enable"}</button>
            )}
          </div>
        )}

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
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="delete my meowsenger data"
        description="this erases your meowsenger memberships, groups you solely own, and your meowsenger profile, then logs you out. it can't be undone. your auth account stays."
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
