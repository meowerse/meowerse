/** @vitest-environment happy-dom */
/**
 * The /join card tells outages and ended sessions apart from a definitive
 * "private or not found": only a 403/404 refusal shows the lock card.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "../test/rtl";

const H = vi.hoisted(() => ({
  session: null as unknown,
  slug: null as unknown,
  invite: null as unknown,
  slugCalls: 0,
}));

vi.mock("../lib/meowsengerApi", () => ({
  getSession: vi.fn(async () => H.session),
  loginUrl: (b: string) => `${b}/auth/login`,
}));
vi.mock("../lib/chat", () => ({
  getBySlug: vi.fn(async () => { H.slugCalls++; return H.slug; }),
  getInviteByCode: vi.fn(async () => H.invite),
  joinChat: vi.fn(),
  acceptInvite: vi.fn(),
  requestJoin: vi.fn(),
}));

import ChannelPreview from "./ChannelPreview";

const authed = { ok: true, status: 200, data: { authenticated: true } };
const preview = { id: "g1", type: "group", name: "Team", memberCount: 3, visibility: "public", isMember: false };

beforeEach(() => {
  H.session = authed;
  H.slug = preview;
  H.invite = { chatId: "g1", type: "group", name: "Team", memberCount: 3 };
  H.slugCalls = 0;
  window.history.replaceState({}, "", "/join?g=team");
});

describe("ChannelPreview failure kinds", () => {
  it("a definitive refusal shows the private / not found card", async () => {
    H.slug = { error: "private" };
    render(<ChannelPreview base="" />);
    await screen.findByText("private or not found");
  });

  it("a dead invite (definitive) shows the private / not found card", async () => {
    window.history.replaceState({}, "", "/join?invite=abc");
    H.invite = { error: "bad_invite" };
    render(<ChannelPreview base="" />);
    await screen.findByText("private or not found");
  });

  it.each([
    ["slug lookup", "/join?g=team", "slug"],
    ["invite lookup", "/join?invite=abc", "invite"],
  ])("an unreachable %s shows 'can't reach meowsenger' + retry, never the lock card", async (_n, url, which) => {
    window.history.replaceState({}, "", url);
    if (which === "slug") H.slug = { error: "unreachable" }; else H.invite = { error: "unreachable" };
    render(<ChannelPreview base="" />);
    await screen.findByText("can't reach meowsenger");
    expect(screen.queryByText("private or not found")).toBeNull();
    expect(screen.queryByText(/ask an admin/)).toBeNull();
    // retry re-runs the lookup and recovers
    H.slug = preview;
    H.invite = { chatId: "g1", type: "group", name: "Team", memberCount: 3 };
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await screen.findByText("Team");
  });

  it("a 401 from the lookup shows the session-ended copy with a sign-in link", async () => {
    H.slug = { error: "unauthorized" };
    render(<ChannelPreview base="" />);
    await screen.findByText(/your session ended\. sign in again/);
    expect(screen.getByRole("link", { name: "sign in" }).getAttribute("href")).toBe("/auth/login");
    expect(screen.queryByText("private or not found")).toBeNull();
  });

  it.each([
    ["network", { kind: "network" }],
    ["5xx", { kind: "http", status: 503, body: null }],
  ])("a session read %s error is unreachable, not locked", async (_n, error) => {
    H.session = { ok: false, error };
    render(<ChannelPreview base="" />);
    await screen.findByText("can't reach meowsenger");
    expect(H.slugCalls).toBe(0);
  });

  it("a session read 401 shows the session-ended copy", async () => {
    H.session = { ok: false, error: { kind: "unauthorized", status: 401 } };
    render(<ChannelPreview base="" />);
    await screen.findByRole("alert");
    expect(screen.getByRole("link", { name: "sign in" })).toBeTruthy();
  });

  it("a missing target is the lock card", async () => {
    window.history.replaceState({}, "", "/join");
    render(<ChannelPreview base="" />);
    await waitFor(() => expect(screen.getByText("private or not found")).toBeTruthy());
  });
});
