import { Footer } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Footer",
  summary: "The page footer: site links, contact links and a one-line legal note.",
  examples: [
    { title: "defaults (meowerse accounts)", wide: true, node: <Footer />, html: true },
    { title: "your own links", wide: true, node: <Footer links={[{ label: "projects", href: "/#projects" }, { label: "ui docs", href: "/ui/" }]} legal="meowerse — a personal project by alxnko." />, html: true },
  ],
  a11y: ["The site links are a labelled navigation region (\"site\").", "Every link is at least 44 px tall."],
  dos: ["Pass your app's own links and legal line."],
  donts: ["Don't put primary actions in the footer."],
} satisfies ComponentPage;
