// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TelegramButton from "./TelegramButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

function mock(verify: unknown = { error: "wrong_code", attemptsLeft: 4 }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    const url = String(u);
    if (url.endsWith("/tg/start")) return json({ ticketId: "tkt_1", deepLink: "https://t.me/bot?start=n" });
    if (url.endsWith("/tg/verify")) return json(verify);
    return json({ ready: false });
  });
}

async function startFlow() {
  const view = render(<TelegramButton base="https://api" />);
  fireEvent.click(screen.getByText("continue with telegram"));
  await screen.findByTestId("tg-code-input");
  return view;
}

describe("TelegramButton code entry", () => {
  it("after the telegram step shows a code input (and never a code of its own)", async () => {
    mock();
    const { container } = await startFlow();
    expect(container.textContent).toContain("enter the code telegram sent you");
    expect(container.querySelector('a[href="https://t.me/bot?start=n"]')).not.toBeNull();
    expect(screen.queryByTestId("tg-match-code")).toBeNull();
  });

  it("submits the typed code with the ticket to /tg/verify (credentialed) and reports a wrong code", async () => {
    const f = mock({ error: "wrong_code", attemptsLeft: 3 });
    await startFlow();
    fireEvent.change(screen.getByTestId("tg-code-input"), { target: { value: "1234 5678" } });
    fireEvent.click(screen.getByText("confirm"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("3 tries left"));
    const call = f.mock.calls.find((c) => String(c[0]).endsWith("/tg/verify"))!;
    expect((call[1] as RequestInit).credentials).toBe("include");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ ticket: "tkt_1", code: "1234 5678" });
  });

  it("a burned ticket returns the user to the start with a clear message", async () => {
    mock({ error: "too_many_attempts" });
    await startFlow();
    fireEvent.change(screen.getByTestId("tg-code-input"), { target: { value: "00000000" } });
    fireEvent.click(screen.getByText("confirm"));
    await screen.findByText("too many wrong codes. start again.");
    expect(screen.queryByTestId("tg-code-input")).toBeNull();
  });
});
