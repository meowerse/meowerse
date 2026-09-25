import type { ComponentPage } from "../types";

export default {
  name: "ConfirmDialog",
  summary: "A modal that asks before something destructive, optionally making you type a phrase or your password.",
  examples: [],
  interactiveOnly: true,
  a11y: [
    "Opens as a modal dialog with focus inside; Escape and \"cancel\" close it.",
    "With confirmPhrase, the phrase is shown exactly in <code>, and the field says \"doesn't match yet\" while it doesn't.",
    "The confirm button stays disabled until the phrase or password is there, and the reason is on screen.",
  ],
  keys: [["Tab / Shift+Tab", "cycles inside the dialog"], ["Escape", "cancels"]],
  dos: ["Use it only for actions that are hard to undo.", "Name the confirm button after the action: \"delete chat\"."],
  donts: ["Don't lowercase or trim the phrase people must type.", "Don't ask for confirmation of harmless actions."],
} satisfies ComponentPage;
