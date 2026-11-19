// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TelegramButton from "./TelegramButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

describe("TelegramButton match code", () => {
  it("shows the match code and the confirm-only-if-it-matches warning next to the open-telegram step", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      String(u).endsWith("/tg/start") ? json({ ticketId: "tkt_1", deepLink: "https://t.me/bot?start=n", matchCode: "4821" }) : json({ ready: false }),
    );
    const { container } = render(<TelegramButton base="https://api" />);
    fireEvent.click(screen.getByText("continue with telegram"));
    const code = await screen.findByTestId("tg-match-code");
    expect(code.textContent).toBe("4821");
    expect(container.textContent).toContain("only if it shows this code");
    expect(container.querySelector('a[href="https://t.me/bot?start=n"]')).not.toBeNull();
  });

  it("renders no code block when the server sent none (older auth worker)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      String(u).endsWith("/tg/start") ? json({ ticketId: "tkt_1", deepLink: "https://t.me/bot?start=n" }) : json({ ready: false }),
    );
    render(<TelegramButton base="https://api" />);
    fireEvent.click(screen.getByText("continue with telegram"));
    await screen.findByText("open telegram to confirm");
    expect(screen.queryByTestId("tg-match-code")).toBeNull();
  });
});
