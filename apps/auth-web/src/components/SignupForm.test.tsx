// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SignupForm from "./SignupForm";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("signup succeeds without recoveryCodes in the response: no codes step, goes straight to the next page", async () => {
  const loc = { href: "" };
  vi.stubGlobal("location", loc);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true, csrf: "c", next: { action: "consent" } }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  render(<SignupForm base="https://api" />);
  fireEvent.change(screen.getByLabelText("username"), { target: { value: "neko_new" } });
  fireEvent.change(screen.getByLabelText("password"), { target: { value: "correct-horse-battery" } });
  fireEvent.submit(screen.getByLabelText("username").closest("form")!);
  await waitFor(() => expect(loc.href).toBe("/consent"));
  expect(screen.queryByText(/recovery/i)).toBeNull();
});
