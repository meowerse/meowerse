export type Theme = "light" | "dark" | "system";
const KEY = "mw-theme";

export function getTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function resolvedTheme(): "light" | "dark" {
  const t = getTheme();
  if (t !== "system") return t;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.add("mw-no-transitions");
  if (theme === "system") {
    localStorage.removeItem(KEY);
    root.removeAttribute("data-theme");
  } else {
    localStorage.setItem(KEY, theme);
    root.setAttribute("data-theme", theme);
  }
  requestAnimationFrame(() => root.classList.remove("mw-no-transitions"));
}

export function toggleTheme(): void {
  applyTheme(resolvedTheme() === "dark" ? "light" : "dark");
}

/** Synchronous script for <head> — sets data-theme before first paint (no FOUC). */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('mw-theme');var r=document.documentElement;r.classList.add('mw-no-transitions');if(t==='light'||t==='dark'){r.setAttribute('data-theme',t);}requestAnimationFrame(function(){r.classList.remove('mw-no-transitions');});}catch(e){}})();`;
