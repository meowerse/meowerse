import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Field } from "./Field";

describe("Field", () => {
  it("associates the hint with the input as its description", () => {
    render(<Field label="username" hint="3-20 chars" name="u" />);
    expect(screen.getByLabelText("username")).toHaveAccessibleDescription(/3-20 chars/);
  });
  it("shows the error as an alert and marks the input invalid", () => {
    render(<Field label="username" error="taken" name="u" />);
    const input = screen.getByLabelText("username");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("taken");
  });
  it("password field toggles visibility", async () => {
    render(<Field label="password" type="password" name="p" />);
    const input = screen.getByLabelText("password") as HTMLInputElement;
    expect(input.type).toBe("password");
    await userEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input.type).toBe("text");
  });
});
