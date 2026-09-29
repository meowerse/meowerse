import { ContactLinks } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "ContactLinks",
  summary: "A row of 44 px icon links to reach the author.",
  examples: [
    { title: "default contacts", node: <ContactLinks />, html: true },
    { title: "your own list", node: <ContactLinks contacts={[{ label: "github", href: "https://github.com/meowerse", icon: "brand-github" }]} />, html: true },
  ],
  a11y: ["Each icon link is named by its label.", "Web links open in a new tab with rel=\"noreferrer noopener\"; mailto opens the mail app in place."],
  dos: ["Keep the list short and familiar."],
  donts: ["Don't use unlabelled icons."],
} satisfies ComponentPage;
