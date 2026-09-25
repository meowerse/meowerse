import { useState } from "react";
import type { Session } from "../lib/useSession";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

/** one link in an AppHeader's nav. */
export interface AppHeaderLink {
  label: string;
  href: string;
}

/** the nav links for each session state an AppHeader can be in. */
export interface AppHeaderLinks {
  /** shown to a signed-out visitor, in every session state. */
  guest: AppHeaderLink[];
  /** shown to a signed-out visitor only once the session is known (not while loading or on error). */
  guestActions: AppHeaderLink[];
  /** shown to a signed-in visitor. */
  signedIn: AppHeaderLink[];
}

/** Default nav for the auth app; other apps (or a docs preview) pass their own. */
const DEFAULT_LINKS: AppHeaderLinks = {
  guest: [
    { label: "about", href: "/about" },
    { label: "developers", href: "/developers" },
    { label: "docs", href: "/docs" },
  ],
  guestActions: [
    { label: "log in", href: "/login" },
    { label: "sign up", href: "/signup" },
  ],
  signedIn: [
    { label: "account", href: "/account" },
    { label: "developers", href: "/developers" },
    { label: "docs", href: "/docs" },
  ],
};

/** the header of meowerse accounts: brand, session-aware navigation, the theme toggle and a phone menu button. */
export function AppHeader({ session, className, links = DEFAULT_LINKS }: {
  /** the current session, from useSession(); its loading/authenticated state decides which links show. */
  session: Session;
  /** extra class names to append. */
  className?: string;
  /** the nav links per session state; defaults to the auth app's set. A docs preview passes links that resolve on its own site. */
  links?: AppHeaderLinks;
}) {
  const [open, setOpen] = useState(false);
  const known = !session.loading && !("error" in session && session.error);
  return (
    <header className={cx("mw-header", className)}>
      <a className="mw-header__brand" href="/" aria-label="meowerse auth — home">
        <span className="mw-brand-meow">meowerse</span><span className="mw-brand-auth">auth</span>
      </a>
      <div className="mw-header__actions">
        <nav className={cx("mw-header__nav", open && "is-open")} aria-label="primary" onClick={() => setOpen(false)}>
          {!session.authenticated && (
            <>
              {links.guest.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
              {known && links.guestActions.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
            </>
          )}
          {!session.loading && session.authenticated && (
            <>
              {links.signedIn.map((l) => <a key={l.href} href={l.href}>{l.label}</a>)}
              <span className="mw-header__user"><Avatar name={session.username} size="sm" /> {session.username}</span>
            </>
          )}
        </nav>
        <ThemeToggle />
        <button className="mw-header__burger" aria-label="menu" aria-expanded={open}
          onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "x" : "menu-2"} size={20} />
        </button>
      </div>
    </header>
  );
}
