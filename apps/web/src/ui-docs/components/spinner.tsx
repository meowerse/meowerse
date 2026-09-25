import { Spinner } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Spinner",
  summary: "A small ring that turns while something loads, in three sizes.",
  examples: [
    { title: "small", node: <Spinner size="sm" label="loading" />, html: true },
    { title: "medium", node: <Spinner label="loading chats" />, html: true },
    { title: "large", node: <Spinner size="lg" label="checking your session" />, html: true },
  ],
  a11y: ["Each spinner is a role=\"status\" with a label.", "Under reduced motion it stops turning; the label still says what is happening."],
  dos: ["Pair a long wait with a StatusLine that says what is happening, and give up with a plain error after a timeout."],
  donts: ["Don't put several spinners in one view.", "Don't spin forever."],
} satisfies ComponentPage;
