import type { Session } from "../lib/useSession";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar } from "./Avatar";
import { cx } from "../lib/cx";

export function AppHeader({ session, className }: { session: Session; className?: string }) {
  return (
    <header className={cx("mw-header", className)}>
      <a className="mw-header__brand" href="/"><span className="mw-header__paw" aria-hidden="true">🐾</span> meowerse</a>
      <nav className="mw-header__nav" aria-label="primary">
        {!session.loading && !session.authenticated && (
          <>
            <a href="/about">about</a>
            <a href="/developers">developers</a>
            <a href="/login">log in</a>
            <a href="/signup">sign up</a>
          </>
        )}
        {!session.loading && session.authenticated && (
          <>
            <a href="/account">account</a>
            <a href="/developers">developers</a>
            <span className="mw-header__user"><Avatar name={session.username} size="sm" /> {session.username}</span>
          </>
        )}
        <ThemeToggle />
      </nav>
    </header>
  );
}
