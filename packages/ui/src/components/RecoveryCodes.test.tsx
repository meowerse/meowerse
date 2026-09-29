import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecoveryCodes } from "./RecoveryCodes";

describe("RecoveryCodes", () => {
  const codes = ["ABCD-1234", "EFGH-5678"];
  it("renders each code case-preserved", () => {
    render(<RecoveryCodes codes={codes} />);
    expect(screen.getByText("ABCD-1234")).toHaveAttribute("data-case", "preserve");
  });
  it("copy-all writes the newline-joined codes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<RecoveryCodes codes={codes} />);
    await userEvent.click(screen.getByRole("button", { name: /copy all/i }));
    expect(writeText).toHaveBeenCalledWith("ABCD-1234\nEFGH-5678");
  });
  it("no codes: no empty list, and nothing to copy", () => {
    render(<RecoveryCodes codes={[]} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: /copy all/i })).toBeDisabled();
  });
  it("a repeated code still shows every entry", () => {
    render(<RecoveryCodes codes={["AAAA-1111", "AAAA-1111"]} />);
    expect(screen.getAllByText("AAAA-1111")).toHaveLength(2);
  });
});
