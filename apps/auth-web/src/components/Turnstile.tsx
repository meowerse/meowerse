import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface TurnstileRef {
  reset: () => void;
}

export interface TurnstileProps {
  siteKey?: string;
  onToken: (t: string) => void;
  onError?: () => void;
  onExpire?: () => void;
}

/**
 * Cloudflare Turnstile widget (bot check) for /login + /signup. Renders ONLY
 * when `siteKey` is provided — with no key it renders nothing and the form
 * submits exactly as before. Exposes a `reset()` method via ref so forms can
 * cleanly request a fresh token when a submission fails or expires.
 */
export const Turnstile = forwardRef<TurnstileRef, TurnstileProps>(function Turnstile(
  { siteKey, onToken, onError, onExpire },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | undefined>(undefined);
  const cb = useRef({ onToken, onError, onExpire });
  cb.current = { onToken, onError, onExpire };

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current);
        } catch {
          // ignore reset errors
        }
      }
    },
  }));

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    let cancelled = false;
    let iv: ReturnType<typeof setInterval> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const el = containerRef.current;

    const tryRender = (): boolean => {
      const t = window.turnstile;
      if (!t || cancelled || !containerRef.current) return false;
      if (widgetIdRef.current) return true;

      try {
        widgetIdRef.current = t.render(el, {
          sitekey: siteKey,
          callback: (token: string) => {
            if (!cancelled) cb.current.onToken(token);
          },
          "expired-callback": () => {
            if (!cancelled) {
              cb.current.onToken("");
              cb.current.onExpire?.();
            }
          },
          "error-callback": () => {
            if (!cancelled) {
              cb.current.onToken("");
              cb.current.onError?.();
            }
          },
        });
        return true;
      } catch {
        if (!cancelled) {
          cb.current.onToken("");
          cb.current.onError?.();
        }
        return false;
      }
    };

    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onerror = () => {
        if (!cancelled) {
          cb.current.onToken("");
          cb.current.onError?.();
        }
      };
      document.head.appendChild(s);
    }

    if (!tryRender()) {
      iv = setInterval(() => {
        if (tryRender() && iv) {
          clearInterval(iv);
          if (timeoutId) clearTimeout(timeoutId);
        }
      }, 100);

      // Guard: if script is blocked or network times out, fire onError
      timeoutId = setTimeout(() => {
        if (!widgetIdRef.current && !cancelled) {
          if (iv) clearInterval(iv);
          cb.current.onError?.();
        }
      }, 8000);
    }

    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
      if (timeoutId) clearTimeout(timeoutId);
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {}
        widgetIdRef.current = undefined;
      }
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="cf-turnstile" style={{ marginTop: "var(--gap-sm)" }} />;
});

export default Turnstile;
