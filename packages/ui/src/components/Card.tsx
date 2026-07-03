import { useId, type ReactNode } from "react";
import { cx } from "../lib/cx";

export function Card({ title, children, className }:
  { title?: string; children: ReactNode; className?: string }) {
  const id = useId();
  if (!title) return <div className={cx("mw-card", className)}>{children}</div>;
  return (
    <section aria-labelledby={id} className={cx("mw-card", className)}>
      <h2 id={id} className="mw-card__title">{title}</h2>
      {children}
    </section>
  );
}
