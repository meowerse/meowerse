import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal open={false} onClose={() => {}} title="t">body</Modal>);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("open dialog is labelled by its title and Esc closes it", async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="revoke access">body</Modal>);
    const dialog = screen.getByRole("dialog", { name: "revoke access" });
    expect(dialog).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("clicking the backdrop closes", async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="t">body</Modal>);
    await userEvent.click(screen.getByTestId("mw-modal-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });
  it("traps Tab focus within the panel (wraps at both edges)", async () => {
    render(
      <Modal open onClose={() => {}} title="t">
        <button>first</button>
        <button>last</button>
      </Modal>,
    );
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});
