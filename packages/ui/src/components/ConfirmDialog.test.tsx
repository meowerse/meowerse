import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("type-to-confirm keeps confirm disabled until the phrase matches", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm}
      title="delete app" description="irreversible" confirmLabel="delete" variant="danger" confirmPhrase="meowsenger" />);
    const btn = screen.getByRole("button", { name: "delete" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/type/i), "meowsenger");
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledWith({ password: undefined });
  });
  it("require-password passes the entered password to onConfirm", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm}
      title="unlink" description="d" confirmLabel="unlink" requirePassword />);
    await userEvent.type(screen.getByLabelText("your password"), "hunter2hunter2");
    await userEvent.click(screen.getByRole("button", { name: "unlink" }));
    expect(onConfirm).toHaveBeenCalledWith({ password: "hunter2hunter2" });
  });
  it("resets the typed phrase when closed, so it reopens disarmed", async () => {
    const onConfirm = vi.fn();
    const { rerender } = render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm}
      title="delete app" description="d" confirmLabel="delete" confirmPhrase="meowsenger" />);
    await userEvent.type(screen.getByLabelText(/type/i), "meowsenger");
    expect(screen.getByRole("button", { name: "delete" })).toBeEnabled();
    rerender(<ConfirmDialog open={false} onCancel={() => {}} onConfirm={onConfirm}
      title="delete app" description="d" confirmLabel="delete" confirmPhrase="meowsenger" />);
    rerender(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm}
      title="delete app" description="d" confirmLabel="delete" confirmPhrase="meowsenger" />);
    expect(screen.getByRole("button", { name: "delete" })).toBeDisabled();
  });
  it("shows the phrase exactly (case kept) and accepts it", async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onCancel={() => {}} onConfirm={onConfirm} title="delete app"
      description="d" confirmLabel="delete" confirmPhrase="MyApp" />);
    expect(screen.getByText("MyApp", { selector: "code" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "MyApp");
    await userEvent.click(screen.getByRole("button", { name: "delete" }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
