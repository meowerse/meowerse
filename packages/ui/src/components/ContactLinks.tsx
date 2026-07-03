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
      {contacts.map((c) => (
        <a key={c.label} href={c.href} aria-label={c.label} className="mw-contacts__link"
          target={c.href.startsWith("http") ? "_blank" : undefined}
          rel={c.href.startsWith("http") ? "noreferrer noopener" : undefined}>
          <i className={`ti ti-${c.icon}`} aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}
