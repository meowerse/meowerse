import { ContactLinks } from "./ContactLinks";
import { cx } from "../lib/cx";

export interface FooterLink {
  label: string;
  href: string;
}

/** Default nav + legal line for the auth app; other apps pass their own. */
const DEFAULT_LINKS: FooterLink[] = [
  { label: "about", href: "/about" },
  { label: "privacy", href: "/privacy" },
  { label: "terms", href: "/terms" },
  { label: "developers", href: "/developers" },
];
const DEFAULT_LEGAL = "meowerse accounts — a personal project by alxnko";

export function Footer({
  className,
  links = DEFAULT_LINKS,
  legal = DEFAULT_LEGAL,
}: {
  className?: string;
  // Nav links; defaults to the auth app's set. Apps like meowsenger pass their own.
  links?: FooterLink[];
  // Legal/attribution line; defaults to the auth app's.
  legal?: string;
}) {
  return (
    <footer className={cx("mw-footer", className)}>
      <nav className="mw-footer__links" aria-label="site">
        {links.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
      </nav>
      <ContactLinks />
      <p className="mw-footer__legal">{legal}</p>
    </footer>
  );
}
