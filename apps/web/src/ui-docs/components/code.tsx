import { Code } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Code",
  summary: "An inline code value, shown exactly as it is, with an optional copy button.",
  examples: [
    { title: "value", node: <Code value="meow.alxnko.dev" />, html: true },
    { title: "with copy", note: "try it in the demo below", node: <Code value="k3m9-X2p4-q8w1" copy /> },
  ],
  a11y: [
    "The value keeps its case: what you see is what you copy.",
    "The copy button is 44×44 px and named \"copy\".",
    "Success is shown by the icon only and a refused clipboard is silent (audit U-19); that is fixed in the accounts redesign (sub-project 3).",
  ],
  keys: [["Tab", "reaches the copy button"], ["Enter or Space", "copies"]],
  dos: ["Use it for ids, keys, codes and commands."],
  donts: ["Don't use it for ordinary words."],
} satisfies ComponentPage;
