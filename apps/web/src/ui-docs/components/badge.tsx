import { Badge } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Badge",
  summary: "A small label for a state or a category: verified, neutral or danger.",
  examples: [
    { title: "verified", node: <Badge variant="verified" icon="rosette-discount-check">verified</Badge>, html: true },
    { title: "neutral", node: <Badge>draft</Badge>, html: true },
    { title: "danger", node: <Badge variant="danger">suspended</Badge>, html: true },
  ],
  a11y: ["The text carries the meaning; the icon is hidden from assistive tech.", "A badge is not interactive."],
  dos: ["Keep it to one or two words."],
  donts: ["Don't use a badge as a button.", "Don't make a badge green unless it means verified or ok."],
} satisfies ComponentPage;
