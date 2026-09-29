import { Icon } from "./Icon";
import { cx } from "../lib/cx";

/** one entry in a ContactLinks row: a labelled, iconed link. */
export type Contact = { label: string; href: string; icon: string };

/** the author's default contact set, used when ContactLinks is given no contacts of its own. */
export const DEFAULT_CONTACTS: Contact[] = [
  { label: "email", href: "mailto:aleksandrnyrko@gmail.com", icon: "mail" },
  { label: "telegram", href: "https://t.me/ALXNK0", icon: "brand-telegram" },
  { label: "instagram", href: "https://instagram.com/alxnko", icon: "brand-instagram" },
  { label: "github", href: "https://github.com/alxnko", icon: "brand-github" },
  { label: "linkedin", href: "https://linkedin.com/in/alxnko", icon: "brand-linkedin" },
];

/** a row of 44 px icon links to reach the author. */
export function ContactLinks({ contacts = DEFAULT_CONTACTS, className }: {
  /** the links to show; defaults to the author's own contacts. */
  contacts?: Contact[];
  /** extra class names to append. */
  className?: string;
}) {
  return (
    <nav className={cx("mw-contacts", className)} aria-label="contact">
      {contacts.map((c) => {
        const external = c.href.startsWith("http");
        return (
          <a key={c.label} href={c.href} className="mw-contacts__link"
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer noopener" : undefined}>
            <Icon name={c.icon} size={19} />
            {/* F9: an external contact link's accessible name says so, without adding visible text. */}
            <span className="sr-only">{c.label}{external ? " (opens in a new tab)" : ""}</span>
          </a>
        );
      })}
    </nav>
  );
}
