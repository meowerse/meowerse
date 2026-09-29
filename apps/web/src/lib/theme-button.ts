// The header theme button without React: ThemeButton.astro renders it, this binds it.
import { resolvedTheme, toggleTheme } from "@meowerse/ui/theme";

type Mode = "light" | "dark";

// C2 (pre-flight ruling): read what the page shows (data-theme) first — this is what a cross-tab
// `storage` event updates directly — and fall back to resolvedTheme() (localStorage/system) only
// when the page has no explicit theme yet. resolvedTheme() itself can throw when storage is blocked.
function current(doc: Document): Mode {
  const attr = doc.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  try {
    return resolvedTheme();
  } catch { // storage blocked (private mode, strict settings): fall back to the system preference
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
}

/** The button names the action it performs. */
export const themeLabel = (theme: Mode): string => (theme === "dark" ? "switch to light theme" : "switch to dark theme");

export function bindThemeButtons(doc: Document = document): void {
  const buttons = [...doc.querySelectorAll<HTMLButtonElement>("[data-theme-button]")];
  if (!buttons.length) return;
  const root = doc.documentElement;
  const sync = () => { const label = themeLabel(current(doc)); for (const b of buttons) b.setAttribute("aria-label", label); };
  for (const b of buttons) {
    b.hidden = false; // rendered [hidden]: it does nothing until this binds it
    b.addEventListener("click", () => {
      try {
        toggleTheme();
      } catch { // the choice can't persist; flip this page only
        root.setAttribute("data-theme", current(doc) === "dark" ? "light" : "dark");
        root.classList.remove("mw-no-transitions");
      }
      sync();
    });
  }
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] }); // other toggles on the page
  addEventListener("storage", (e) => { // another tab chose
    if (e.key !== "mw-theme") return;
    if (e.newValue === "light" || e.newValue === "dark") root.setAttribute("data-theme", e.newValue);
    else root.removeAttribute("data-theme");
  });
  if (typeof matchMedia !== "undefined") matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", sync);
  sync();
}
