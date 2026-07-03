import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast({ message: "access revoked", variant: "success" })}>go</button>;
}

describe("Toast", () => {
  it("useToast pushes a toast that renders in the live region", async () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(await screen.findByText("access revoked")).toBeInTheDocument();
  });
});
