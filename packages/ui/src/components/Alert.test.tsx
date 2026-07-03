import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Alert } from "./Alert";

describe("Alert", () => {
  it("error variant is an assertive alert", () => {
    render(<Alert variant="error">that name's already taken. try another.</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("already taken");
  });
  it("dismiss button fires onDismiss", async () => {
    const fn = vi.fn();
    render(<Alert variant="success" onDismiss={fn}>saved</Alert>);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(fn).toHaveBeenCalledOnce();
  });
});
