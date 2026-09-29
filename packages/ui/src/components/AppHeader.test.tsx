import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppHeader } from "./AppHeader";

describe("AppHeader", () => {
  it("guest sees log in / sign up, not account", () => {
    render(<AppHeader session={{ loading: false, authenticated: false }} />);
    expect(screen.getByRole("link", { name: "log in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sign up" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "account" })).toBeNull();
  });
  it("authed sees account + developers + username, not log in", () => {
    render(<AppHeader session={{ loading: false, authenticated: true, username: "alex", verified: true }} />);
    expect(screen.getByRole("link", { name: "account" })).toBeInTheDocument();
    expect(screen.getByText("alex")).toBeInTheDocument();
    // the username is written next to the avatar, so the avatar is decorative: the name is read once
    expect(screen.queryByRole("img", { name: "alex" })).toBeNull();
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
  });
  it("exposes the docs link to guests and authed users", () => {
    const { rerender } = render(<AppHeader session={{ loading: false, authenticated: false }} />);
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "/docs");
    rerender(<AppHeader session={{ loading: false, authenticated: true, username: "alex", verified: true }} />);
    expect(screen.getByRole("link", { name: "docs" })).toHaveAttribute("href", "/docs");
  });
  it("while loading shows public nav but not log in / account (U-02: no vanishing nav)", () => {
    render(<AppHeader session={{ loading: true, authenticated: false }} />);
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "account" })).toBeNull();
  });
  it("keeps public nav while loading and hides log in on error", () => {
    const { rerender } = render(<AppHeader session={{ loading: true, authenticated: false }} />);
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
    rerender(<AppHeader session={{ loading: false, authenticated: false, error: "network" }} />);
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
    expect(screen.getByRole("link", { name: "about" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "developers" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "docs" })).toBeInTheDocument();
    rerender(<AppHeader session={{ loading: false, authenticated: false }} />);
    expect(screen.getByRole("link", { name: "log in" })).toBeInTheDocument();
  });
  it("accepts custom links, so a caller (a docs preview, another app) can point at pages that resolve on its own site", () => {
    const links = {
      guest: [{ label: "home", href: "/" }],
      guestActions: [{ label: "sign in", href: "/signin" }],
      signedIn: [{ label: "profile", href: "/profile" }],
    };
    const { rerender } = render(<AppHeader session={{ loading: false, authenticated: false }} links={links} />);
    expect(screen.getByRole("link", { name: "home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "sign in" })).toHaveAttribute("href", "/signin");
    expect(screen.queryByRole("link", { name: "about" })).toBeNull();
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
    rerender(<AppHeader session={{ loading: false, authenticated: true, username: "alex", verified: true }} links={links} />);
    expect(screen.getByRole("link", { name: "profile" })).toHaveAttribute("href", "/profile");
    expect(screen.queryByRole("link", { name: "account" })).toBeNull();
  });
  it("still hides guestActions while the session isn't known yet, even with custom links", () => {
    const links = { guest: [{ label: "home", href: "/" }], guestActions: [{ label: "sign in", href: "/signin" }], signedIn: [] };
    render(<AppHeader session={{ loading: true, authenticated: false }} links={links} />);
    expect(screen.getByRole("link", { name: "home" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "sign in" })).toBeNull();
  });
  it("burger toggles the mobile nav open, and a nav click closes it", async () => {
    const user = userEvent.setup();
    render(<AppHeader session={{ loading: false, authenticated: false }} />);
    const nav = screen.getByRole("navigation", { name: "primary" });
    const burger = screen.getByRole("button", { name: "menu" });
    expect(nav.className).not.toContain("is-open");
    await user.click(burger);
    expect(nav.className).toContain("is-open");
    expect(burger).toHaveAttribute("aria-expanded", "true");
    // jsdom can't navigate: cancel the link's default action (capture phase, before React's
    // bubbling handler) so the click still reaches the nav without a "Not implemented" error.
    const noNavigate = (e: Event) => e.preventDefault();
    document.addEventListener("click", noNavigate, { capture: true });
    try {
      await user.click(screen.getByRole("link", { name: "about" }));
    } finally {
      document.removeEventListener("click", noNavigate, { capture: true });
    }
    expect(nav.className).not.toContain("is-open");
  });
});
