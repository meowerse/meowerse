import { ThemeToggle } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "ThemeToggle",
  summary: "A 44 px button that switches between the dark and light themes and remembers the choice.",
  examples: [{ title: "server render", note: "shows the dark-theme icon until it hydrates", node: <ThemeToggle /> }],
  a11y: ["Its name says what pressing it does: \"switch to light theme\" or \"switch to dark theme\".", "The choice is stored per site under mw-theme."],
  keys: [["Tab", "focuses it"], ["Enter or Space", "switches the theme"]],
  dos: ["Put it in the header, at the end."],
  donts: ["Don't hide the theme choice in a menu."],
} satisfies ComponentPage;
