import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Cloudflare Turnstile widget (bot check) for /login + /signup. Renders ONLY
 * when `siteKey` is provided — with no key it renders nothing and the form
 * submits exactly as before, so this is a no-op until the keys are provisioned.
 * `onToken` fires with the solved token, and with "" on expiry/error so the
 * form knows to wait for a fresh one.
 */
export default function Turnstile({ siteKey, onToken }: { siteKey?: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src = SCRIPT_SRC;
      s.async = true;
      document.head.appendChild(s);
    }
    let widgetId: string | undefined;
    let cancelled = false;
    let iv: ReturnType<typeof setInterval> | undefined;
    const el = ref.current;
    const tryRender = (): boolean => {
      const t = window.turnstile;
      if (!t || cancelled) return false;
      widgetId = t.render(el, {
        sitekey: siteKey,
        callback: (token: string) => cb.current(token),
        "expired-callback": () => cb.current(""),
        "error-callback": () => cb.current(""),
      });
      return true;
    };
    // the script loads async — poll until window.turnstile exists, then render once
    if (!tryRender()) iv = setInterval(() => { if (tryRender() && iv) clearInterval(iv); }, 200);
    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={ref} className="cf-turnstile" style={{ marginTop: "var(--gap-sm)" }} />;
}
