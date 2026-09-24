import { useState } from "react";
import type { Session } from "../lib/useSession";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { cx } from "../lib/cx";

export function AppHeader({ session, className }: { session: Session; className?: string }) {
  const [open, setOpen] = useState(false);
  const known = !session.loading && !("error" in session && session.error);
  const showNav = true;
  return (
    <header className={cx("mw-header", className)}>
      <a className="mw-header__brand" href="/" aria-label="meowerse auth — home">
        <span className="mw-brand-meow">meowerse</span><span className="mw-brand-auth">auth</span>
      </a>
      <div className="mw-header__actions">
        <nav className={cx("mw-header__nav", open && "is-open")} aria-label="primary" onClick={() => setOpen(false)}>
          {showNav && !session.authenticated && (
            <>
              <a href="/about">about</a>
              <a href="/developers">developers</a>
              <a href="/docs">docs</a>
              {known && (
                <>
                  <a href="/login">log in</a>
                  <a href="/signup">sign up</a>
                </>
              )}
            </>
          )}
          {!session.loading && session.authenticated && (
            <>
              <a href="/account">account</a>
              <a href="/developers">developers</a>
              <a href="/docs">docs</a>
              <span className="mw-header__user"><Avatar name={session.username} size="sm" /> {session.username}</span>
            </>
          )}
        </nav>
        <ThemeToggle />
        {showNav && (
          <button className="mw-header__burger" aria-label="menu" aria-expanded={open}
            onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? "x" : "menu-2"} size={20} />
          </button>
        )}
      </div>
    </header>
  );
}
