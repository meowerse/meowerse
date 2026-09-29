import { Button } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Button",
  summary: "A native button in four variants and two sizes, with a loading state.",
  examples: [
    { title: "primary", note: "the one main action", node: <Button variant="primary">save</Button>, html: true },
    { title: "secondary", node: <Button>cancel</Button>, html: true },
    { title: "ghost", node: <Button variant="ghost">more options</Button>, html: true },
    { title: "danger", node: <Button variant="danger">delete account</Button>, html: true },
    { title: "small", note: "36 px drawn, 44 px hit area", node: <Button size="sm">copy all</Button>, html: true },
    { title: "loading", node: <Button variant="primary" loading>saving</Button> },
    { title: "disabled", node: <Button variant="primary" disabled>save</Button>, html: true },
  ],
  a11y: [
    "A native <button>: Enter and Space work, and focus shows the 2 px ring.",
    "loading disables it and adds a spinner; keep the label saying what is happening.",
    "It sets no default type (audit U-20): inside a form, set type=\"button\" on buttons that must not submit.",
  ],
  keys: [["Tab", "focuses the button"], ["Enter or Space", "presses it"]],
  dos: ["Use one primary (green) button per view, for the main action.", "Explain a disabled button next to it."],
  donts: ["Don't put two green buttons in one view.", "Don't enable a button and then refuse the click with \"not ready\"."],
} satisfies ComponentPage;
