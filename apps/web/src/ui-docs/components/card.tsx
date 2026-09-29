import { Card } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Card",
  summary: "A flat panel that groups related content, with an optional title.",
  examples: [
    { title: "with a title", node: <Card title="profile"><p>signed in as alxnko.</p></Card>, html: true },
    { title: "without a title", node: <Card><p>a plain card groups related content.</p></Card>, html: true },
  ],
  a11y: ["With a title it is a section labelled by its heading.", "The title is always an h2 (audit U-21); place cards where an h2 fits the page outline."],
  dos: ["Use cards to group a few related things."],
  donts: ["Don't nest cards.", "Don't make a whole card clickable without a real link inside it."],
} satisfies ComponentPage;
