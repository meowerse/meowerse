import { Footer } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Footer",
  summary: "The page footer: site links, contact links and a one-line legal note.",
  examples: [
    // The live preview points at this docs site's own pages; the auth app's real defaults
    // (about, privacy, terms, developers) are documented in the props table's default column
    // instead of rendered here, since they 404 on meow.alxnko.dev.
    { title: "this site's footer", note: "the live preview uses this site's links, not the auth app's real defaults", wide: true,
      node: <Footer links={[{ label: "projects", href: "/#projects" }, { label: "ui docs", href: "/ui/" }, { label: "components", href: "/ui/components/" }]} legal="meowerse — a personal project by alxnko." />, html: true },
  ],
  a11y: ["The site links are a labelled navigation region (\"site\").", "Every link is at least 44 px tall."],
  dos: ["Pass your app's own links and legal line."],
  donts: ["Don't put primary actions in the footer."],
} satisfies ComponentPage;
