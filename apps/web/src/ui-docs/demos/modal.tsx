import { useState } from "react";
import { Button, Checkbox, Field, Icon, Modal } from "@meowerse/ui";

// A rename dialog. While the name is empty, "clear" is visibility:hidden and "save" is disabled; the
// extra options are display:none until opened. Tab must skip all three (Modal's usable() rules).
export default function Demo() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const empty = name.trim() === "";
  const close = () => { setOpen(false); setMore(false); };
  return (
    <div className="demo">
      <Button onClick={() => setOpen(true)}>rename chat</Button>
      {saved !== null && <p role="status" className="demo__out">renamed to “{saved}”</p>}
      <Modal open={open} onClose={close} title="rename chat">
        <div className="demo-modal">
          <div className="demo-modal__row">
            <Field label="new name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
            <button type="button" aria-label="clear the name" className={empty ? "demo-modal__clear is-invisible" : "demo-modal__clear"} onClick={() => setName("")}>
              <Icon name="x" />
            </button>
          </div>
          <Button variant="ghost" aria-expanded={more} aria-controls="demo-more" onClick={() => setMore((m) => !m)}>{more ? "fewer options" : "more options"}</Button>
          <div id="demo-more" className={more ? "demo-modal__more" : "demo-modal__more is-collapsed"}>
            <Checkbox label="tell the members" />
          </div>
          {empty && <p className="mw-field__hint">type a name to save.</p>}
          <div className="mw-confirm__actions">
            <Button onClick={close}>cancel</Button>
            <Button variant="primary" disabled={empty} onClick={() => { setSaved(name.trim()); setName(""); close(); }}>save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
