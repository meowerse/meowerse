import { Kbd } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Kbd",
  summary: "A keycap for keyboard shortcuts in text.",
  examples: [
    { title: "one key", node: <Kbd>Enter</Kbd>, html: true },
    { title: "a combination", node: <><Kbd>Shift</Kbd> + <Kbd>Enter</Kbd></>, html: true },
  ],
  a11y: ["A native <kbd> element; screen readers read the key name."],
  dos: ["Write key names as they appear on keyboards."],
  donts: ["Don't use it for buttons on screen."],
} satisfies ComponentPage;
