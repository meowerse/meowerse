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
  it("a blank hint or error is ignored: no empty alert, not marked invalid, no empty description", () => {
    render(<Field label="username" hint=" " error={"  "} name="u" />);
    const input = screen.getByLabelText("username");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("labelPlacement defaults to above: label first, no float class, the caller's placeholder untouched", () => {
    const { container } = render(<Field label="username" name="u" />);
    const root = container.firstElementChild!;
    expect(root).toHaveClass("mw-field");
    expect(root).not.toHaveClass("mw-field--float");
    expect(root.firstElementChild?.tagName).toBe("LABEL");
    expect(root.firstElementChild).not.toHaveAttribute("class");
    expect(screen.getByLabelText("username")).not.toHaveAttribute("placeholder");
  });
  it("labelPlacement=float: same accessible name and description, label follows the input, blank placeholder becomes a space", () => {
    const { container } = render(<Field label="username" labelPlacement="float" hint="3-20 chars" name="u" />);
    expect(container.firstElementChild).toHaveClass("mw-field", "mw-field--float");
    const input = screen.getByRole("textbox", { name: "username" });
    expect(input).toHaveAccessibleDescription("3-20 chars");
    expect(input).toHaveAttribute("placeholder", " ");
    const label = input.nextElementSibling!;
    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveClass("mw-field__label");
    expect(label).toHaveAttribute("for", input.id);
    expect(container.querySelectorAll("label")).toHaveLength(1);
  });
  it("labelPlacement=float keeps a real placeholder, errors and the password reveal", async () => {
    render(<Field label="password" labelPlacement="float" type="password" placeholder="at least 12" error="too short" name="p" />);
    const input = screen.getByLabelText("password") as HTMLInputElement;
    expect(input).toHaveAttribute("placeholder", "at least 12");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.closest(".mw-field")).toHaveClass("mw-field--error");
    await userEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(input.type).toBe("text");
  });
});
