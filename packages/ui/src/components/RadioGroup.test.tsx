import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup } from "./RadioGroup";

describe("RadioGroup", () => {
  const opts = [{ label: "public", value: "public" }, { label: "confidential", value: "confidential" }];
  it("renders options and reports the picked value", async () => {
    const fn = vi.fn();
    render(<RadioGroup name="ct" legend="app type" options={opts} value="public" onChange={fn} />);
    await userEvent.click(screen.getByRole("radio", { name: "confidential" }));
    expect(fn).toHaveBeenCalledWith("confidential");
  });
  it("marks the selected radio checked", () => {
    render(<RadioGroup name="ct" legend="app type" options={opts} value="confidential" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "confidential" })).toBeChecked();
  });
  it("labels still work for values with spaces or repeats, and no options is an empty group, not a crash", () => {
    render(<RadioGroup name="x" legend="pick" options={[{ label: "a b", value: "a b" }, { label: "again", value: "a b" }]} value="a b" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "a b" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "again" })).toBeInTheDocument();
    render(<RadioGroup name="y" legend="nothing" options={[]} value="" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "nothing" }).querySelectorAll("input")).toHaveLength(0);
  });
});
