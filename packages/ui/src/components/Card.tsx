import { useId, type ReactNode } from "react";
import { cx } from "../lib/cx";

/** a flat panel that groups related content, with an optional title. */
export function Card({ title, children, className }: {
  /** the card's heading, always rendered as an h2; place cards where an h2 fits the page outline. An
   *  empty or blank title renders no heading (an empty h2 would name the region with nothing). */
  title?: string;
  /** the card's content. */
  children: ReactNode;
  /** extra class names to append. */
  className?: string;
}) {
  const id = useId();
  if (!title?.trim()) return <div className={cx("mw-card", className)}>{children}</div>;
  return (
    <section aria-labelledby={id} className={cx("mw-card", className)}>
      <h2 id={id} className="mw-card__title">{title}</h2>
      {children}
    </section>
  );
}
