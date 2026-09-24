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
  it("burger toggles the mobile nav open, and a nav click closes it", async () => {
    const user = userEvent.setup();
    render(<AppHeader session={{ loading: false, authenticated: false }} />);
    const nav = screen.getByRole("navigation", { name: "primary" });
    const burger = screen.getByRole("button", { name: "menu" });
    expect(nav.className).not.toContain("is-open");
    await user.click(burger);
    expect(nav.className).toContain("is-open");
    expect(burger).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("link", { name: "about" }));
    expect(nav.className).not.toContain("is-open");
  });
});
