// Copy buttons for code blocks: visible and announced success, and a plain instruction when the
// clipboard refuses (B9: no silent failure; U-19's lesson).
type Clip = Pick<Clipboard, "writeText"> | undefined;

export function bindCopyButtons(doc: Document = document, clip: Clip = globalThis.navigator?.clipboard): void {
  for (const b of doc.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    if (b.dataset.bound) continue;
    b.dataset.bound = "1";
    b.addEventListener("click", async () => {
      const id = b.dataset.copy ?? "";
      const status = doc.querySelector<HTMLElement>(`[data-copy-status="${id}"]`);
      try {
        if (!clip) throw new Error("no clipboard");
        await clip.writeText(doc.getElementById(id)?.textContent ?? "");
        b.textContent = "copied";
        if (status) status.textContent = "copied to the clipboard";
      } catch {
        b.textContent = "copy failed";
        if (status) status.textContent = "copy failed — select the code and copy it by hand";
      }
      setTimeout(() => { b.textContent = "copy"; }, 2000);
    });
  }
}
