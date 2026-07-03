import { render, screen } from "@testing-library/react";
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
  it("while loading shows only brand + theme toggle (no nav flash)", () => {
    render(<AppHeader session={{ loading: true, authenticated: false }} />);
    expect(screen.queryByRole("link", { name: "log in" })).toBeNull();
    expect(screen.queryByRole("link", { name: "account" })).toBeNull();
  });
});
