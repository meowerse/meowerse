import { ContactLinks } from "./ContactLinks";
import { cx } from "../lib/cx";

const LINKS = [
  { label: "about", href: "/about" },
  { label: "privacy", href: "/privacy" },
  { label: "terms", href: "/terms" },
  { label: "developers", href: "/developers" },
];

export function Footer({ className }: { className?: string }) {
  return (
    <footer className={cx("mw-footer", className)}>
      <nav className="mw-footer__links" aria-label="site">
        {LINKS.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
      </nav>
      <ContactLinks />
      <p className="mw-footer__legal">meowerse accounts — a personal project by alxnko</p>
    </footer>
  );
}
