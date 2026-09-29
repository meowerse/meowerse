import { Prompt } from "@meowerse/ui";
import type { ComponentPage } from "../types";
const noop = () => {};

export default {
  name: "Prompt",
  summary: "The chat composer: a › glyph before a normal, auto-growing textarea, with a visible send button.",
  examples: [
    { title: "empty", note: "send is aria-disabled", node: <Prompt label="message" value="" onChange={noop} onSubmit={noop} /> },
    { title: "with text", node: <Prompt label="message" value="see you at 7" onChange={noop} onSubmit={noop} /> },
    { title: "busy", note: "still editable; sends queue", node: <Prompt label="message" value="and one more thing" busy onChange={noop} onSubmit={noop} /> },
  ],
  a11y: [
    "A labelled textarea: the label is visually hidden and the placeholder repeats it.",
    "On desktop, Enter sends and Shift+Enter adds a line; on phones, Enter adds a line and the button sends. Nothing is sent while an input method is composing.",
    "The field is never disabled; the send button is 44×44 px and named \"send\".",
  ],
  keys: [["Enter", "sends (desktop)"], ["Shift+Enter", "adds a line"], ["Tab", "moves to the send button"]],
  dos: ["Queue sends while offline instead of disabling the field."],
  donts: ["Don't make it a borderless command line or add a blinking block cursor (spec §7)."],
} satisfies ComponentPage;
