import { Checkbox } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Checkbox",
  summary: "A native checkbox with its label, in a 44 px row.",
  examples: [
    { title: "unchecked", node: <Checkbox label="remember this device" />, html: true },
    { title: "checked", node: <Checkbox label="keep me signed in" defaultChecked />, html: true },
    { title: "disabled", node: <Checkbox label="sync across devices (not available yet)" disabled />, html: true },
  ],
  a11y: ["A native checkbox tied to its label: clicking the text toggles it.", "Space toggles it; focus shows the ring."],
  keys: [["Tab", "focuses it"], ["Space", "toggles it"]],
  dos: ["Word the label as the thing that becomes true when checked."],
  donts: ["Don't use a checkbox for an action that happens at once; use a button."],
} satisfies ComponentPage;
