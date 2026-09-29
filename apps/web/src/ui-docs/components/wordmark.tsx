import { Wordmark } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Wordmark",
  summary: "An app's name in VT323 with an underscore and a blinking block cursor.",
  examples: [
    { title: "meowerse", node: <Wordmark name="meowerse" />, html: true },
    { title: "meowsenger", node: <Wordmark name="meowsenger" />, html: true },
    { title: "auth", node: <Wordmark name="auth" />, html: true },
    { title: "as a home link", node: <Wordmark name="ui" href="/ui/" />, html: true },
  ],
  a11y: ["As a link, it is named \"<name> home\" and is 44 px tall.", "The cursor is aria-hidden and stops blinking under reduced motion."],
  dos: ["Use one wordmark per page, in the header or the hero."],
  donts: ["Don't set other text in VT323: its subset only has the wordmark letters."],
} satisfies ComponentPage;
