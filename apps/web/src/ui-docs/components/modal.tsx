import type { ComponentPage } from "../types";

export default {
  name: "Modal",
  summary: "A dialog over the page that keeps focus inside until it closes.",
  examples: [],
  interactiveOnly: true,
  a11y: [
    "role=\"dialog\" with aria-modal, labelled by its title.",
    "Focus moves inside on open, cycles only through controls you can use (it skips disabled, hidden, display:none and visibility:hidden ones) and returns to the trigger on close.",
    "Escape and the backdrop close it; with two dialogs open, only the top one reacts.",
    "It has no close button of its own and doesn't lock page scroll yet (audit U-08): always give it a visible \"cancel\" or \"close\" button.",
  ],
  keys: [["Tab / Shift+Tab", "cycles through the dialog's controls"], ["Escape", "closes it"]],
  dos: ["Put the main action last and a cancel button next to it."],
  donts: ["Don't open a modal on page load.", "Don't put a whole page inside one."],
} satisfies ComponentPage;
