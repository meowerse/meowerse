import { useId, useState } from "react";
import { Button, Checkbox, Field, Icon, Modal } from "@meowerse/ui";

// A rename dialog whose two hidden controls sit at the trap's EDGES (fix round 1: mid-order hidden
// controls left native Tab to skip them on its own, so a broken usable() never showed). "clear" is
// visibility:hidden and, while empty, the FIRST focusable thing in the panel; the "advanced" section
// is display:none and, while collapsed, the LAST — so wrapping (Shift+Tab from the true first, Tab
// from the true last) only lands correctly if Modal's usable() truly excludes both.
export default function Demo() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const hintId = useId();
  const empty = name.trim() === "";
  const close = () => { setOpen(false); setMore(false); };
  return (
    <div className="demo">
      <Button onClick={() => setOpen(true)}>rename chat</Button>
      {saved !== null && <p role="status" className="demo__out">renamed to “{saved}”</p>}
      <Modal open={open} onClose={close} title="rename chat">
        <div className="demo-modal">
          <div className="demo-modal__row">
            <button type="button" aria-label="clear the name" className={empty ? "demo-modal__clear is-invisible" : "demo-modal__clear"} onClick={() => setName("")}>
              <Icon name="x" />
            </button>
            <Field label="new name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
          </div>
          {empty && <p id={hintId} className="mw-field__hint">type a name to save.</p>}
          <div className="mw-confirm__actions">
            <Button onClick={close}>cancel</Button>
            <Button variant="primary" disabled={empty} aria-describedby={empty ? hintId : undefined}
              onClick={() => { setSaved(name.trim()); setName(""); close(); }}>save</Button>
          </div>
          <Button variant="ghost" aria-expanded={more} aria-controls="demo-advanced" onClick={() => setMore((m) => !m)}>{more ? "fewer options" : "more options"}</Button>
          <div id="demo-advanced" className={more ? "demo-modal__more" : "demo-modal__more is-collapsed"}>
            <Checkbox label="tell the members" />
          </div>
        </div>
      </Modal>
    </div>
  );
}
