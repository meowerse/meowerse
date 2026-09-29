import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";

type ToastItem = { id: number; message: string; variant: "success" | "error" | "info" };
type ToastInput = { message: string; variant?: ToastItem["variant"]; duration?: number };

const Ctx = createContext<(t: ToastInput) => void>(() => {});
/** returns a function that shows one toast; call it inside a ToastProvider. */
export function useToast() { return useContext(Ctx); }

/** short notices that appear at the bottom of the screen and go away on their own; useToast() shows one. */
export function ToastProvider({ children }: {
  /** the app rendered under the provider; toasts render alongside it. */
  children: ReactNode;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setItems((cur) => [...cur, { id, message: t.message, variant: t.variant ?? "info" }]);
    setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), t.duration ?? 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="mw-toasts" role="region" aria-live="polite" aria-label="notifications">
        {items.map((t) => (
          <div key={t.id} className={cx("mw-toast", `mw-toast--${t.variant}`)}>{t.message}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
