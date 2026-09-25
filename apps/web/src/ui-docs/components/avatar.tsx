import { Avatar } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Avatar",
  summary: "A rounded square with a person's initial, in three sizes.",
  examples: [
    { title: "small", node: <Avatar name="alxnko" size="sm" />, html: true },
    { title: "medium", node: <Avatar name="Мяу" />, html: true },
    { title: "large", node: <Avatar name="Cats & Co" size="lg" />, html: true },
  ],
  a11y: [
    "An image named by the person's name (role=\"img\" with aria-label, audit U-15); the initial itself is hidden from assistive tech.",
    "Where the name is already written next to it, the avatar repeats it; that's harmless, but keep the visible name.",
  ],
  dos: ["Show the person's name next to the avatar in lists and headers."],
  donts: ["Don't rely on the initial alone to identify someone."],
} satisfies ComponentPage;
