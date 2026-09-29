// Updates a server-rendered <StatusLine live> in place without React. The status-dom test compares the
// result with StatusLine's own markup for every state, so the two can't drift apart.
import { STATUS_TAGS, type StatusState } from "@meowerse/ui/status";

const WORD: Record<StatusState, string> = { ok: "ok", wait: "working", fail: "error", info: "info" };

export function setStatus(p: HTMLElement, state: StatusState, text: string): void {
  const rest = [...p.classList].filter((c) => c !== "mw-status" && !c.startsWith("mw-status--"));
  p.className = ["mw-status", `mw-status--${state}`, ...rest].join(" ");
  p.setAttribute("role", state === "fail" ? "alert" : "status");
  const tag = p.querySelector(".mw-status__tag");
  const word = p.querySelector(":scope > .sr-only");
  const body = p.querySelector(".mw-status__text");
  if (tag) tag.textContent = STATUS_TAGS[state];
  if (word) word.textContent = `${WORD[state]}: `;
  if (body) body.textContent = text;
}
