import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export type Contact = { label: string; href: string; icon: string };

export const DEFAULT_CONTACTS: Contact[] = [
  { label: "email", href: "mailto:aleksandrnyrko@gmail.com", icon: "mail" },
  { label: "telegram", href: "https://t.me/ALXNK0", icon: "brand-telegram" },
  { label: "instagram", href: "https://instagram.com/alxnko", icon: "brand-instagram" },
  { label: "github", href: "https://github.com/alxnko", icon: "brand-github" },
  { label: "linkedin", href: "https://linkedin.com/in/alxnko", icon: "brand-linkedin" },
];

export function ContactLinks({ contacts = DEFAULT_CONTACTS, className }:
  { contacts?: Contact[]; className?: string }) {
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
