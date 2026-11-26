import { Skeleton } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Skeleton",
  summary: "A placeholder block that holds a loading item's exact box, so the content swaps in without moving anything.",
  examples: [
    { title: "a line of text", node: <Skeleton className="doc-skel-line" />, html: true },
    { title: "a button", node: <Skeleton className="doc-skel-button" />, html: true },
  ],
  a11y: [
    "Each block is aria-hidden: name the loading region once with a role=\"status\" and a label on its wrapper (or aria-busy on the container), not on every block.",
    "The soft pulse is opacity only and stops under reduced motion.",
  ],
  dos: ["Set the height to what the loaded content will take, and keep the loaded state in the same box (a min-height on the container) so nothing shifts."],
  donts: ["Don't guess a taller box than the content: it leaves a gap, or shifts everything below when the data arrives.", "Don't use it for a wait with no known shape: use a Spinner."],
} satisfies ComponentPage;
