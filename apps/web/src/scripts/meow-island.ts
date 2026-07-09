// Vanilla replacement for the old React MeowList island: same UI (text input +
// add button + list) and same behavior (GET the list on load, POST to create),
// without shipping react/react-dom to the client. Config (api base + demo token)
// arrives via data-* attributes on #meow-app so this stays a plain client module.
import type { Meow } from "../lib/api";

const app = document.getElementById("meow-app");
if (app) {
  const base = app.dataset.base ?? "";
  const token = app.dataset.token ?? "";
  const input = document.getElementById("meow-text") as HTMLInputElement;
  const addBtn = document.getElementById("meow-add") as HTMLButtonElement;
  const list = document.getElementById("meow-list") as HTMLUListElement;

  const renderItem = (m: Meow): HTMLLIElement => {
    // Matches the old JSX: `{text} <code>{slug}</code>`.
    const li = document.createElement("li");
    li.append(document.createTextNode(m.text + " "));
    const code = document.createElement("code");
    code.textContent = m.slug;
    li.append(code);
    return li;
  };

  const load = async () => {
    try {
      const res = await fetch(`${base}/api/meows`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const meows = (await res.json()) as Meow[];
      for (const m of meows) list.append(renderItem(m));
    } catch {
      // swallow, same as the old island's `.catch(() => {})`
    }
  };

  const add = async () => {
    const text = input.value;
    if (!text.trim()) return;
    const res = await fetch(`${base}/api/meows`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return; // old createMeow threw here → no list/input change
    const m = (await res.json()) as Meow;
    list.prepend(renderItem(m));
    input.value = "";
  };

  addBtn.addEventListener("click", add);
  void load();
}
