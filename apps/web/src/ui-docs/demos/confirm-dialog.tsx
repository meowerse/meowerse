import { useState } from "react";
import { Button, ConfirmDialog } from "@meowerse/ui";

// The phrase has capitals and an ampersand: it must be shown and matched exactly (U-31, B14).
export default function Demo() {
  const [open, setOpen] = useState<"phrase" | "password" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="demo">
      <div className="btn-row">
        <Button variant="danger" onClick={() => setOpen("phrase")}>delete “Cats &amp; Co”</Button>
        <Button onClick={() => setOpen("password")}>sign out everywhere</Button>
      </div>
      {done && <p role="status" className="demo__out">{done}</p>}
      <ConfirmDialog
        open={open === "phrase"} onCancel={() => setOpen(null)}
        onConfirm={() => { setOpen(null); setDone("deleted (not really: this is a demo)."); }}
        title="delete this group?" description="Everyone loses the chat history. This can't be undone."
        confirmLabel="delete group" confirmPhrase="Cats & Co"
      />
      <ConfirmDialog
        open={open === "password"} variant="primary" requirePassword onCancel={() => setOpen(null)}
        onConfirm={() => { setOpen(null); setDone("signed out everywhere (not really: this is a demo)."); }}
        title="sign out everywhere?" description="Every device signs out, this one included." confirmLabel="sign out"
      />
    </div>
  );
}
