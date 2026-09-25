import { Cursor } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Cursor",
  summary: "The block cursor of the wordmarks, blinking at 1 Hz in steps.",
  examples: [
    { title: "blinking", node: <Cursor />, html: true },
    { title: "static", node: <Cursor blink={false} />, html: true },
  ],
  a11y: ["aria-hidden: purely decorative.", "It stops blinking under reduced motion."],
  dos: ["Use it in wordmarks and headings."],
  donts: ["Never put a blinking block cursor in an input field (spec §7)."],
} satisfies ComponentPage;
