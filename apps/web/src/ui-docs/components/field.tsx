import { Field } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Field",
  summary: "A labelled text input with an optional hint or error, and a reveal button for passwords.",
  examples: [
    { title: "with a hint", node: <Field label="username" hint="letters, digits and _ only" autoCapitalize="none" autoCorrect="off" spellCheck={false} />, html: true },
    { title: "password", note: "with a reveal button", node: <Field label="password" type="password" defaultValue="correct horse" /> },
    { title: "error", node: <Field label="username" defaultValue="alxnko" error="that name is taken — try another" />, html: true },
    { title: "disabled", node: <Field label="email" defaultValue="not collected" disabled />, html: true },
    { title: "floating label", note: "labelPlacement=\"float\": rests inside while empty, moves onto the border once focused or filled",
      node: <Field label="username" labelPlacement="float" autoCapitalize="none" autoCorrect="off" spellCheck={false} />, html: true },
    { title: "floating label, filled", note: "stays visible on the border; never runs under the reveal button", node: <Field label="password" labelPlacement="float" type="password" defaultValue="correct horse" hint="12–128 characters" /> },
  ],
  a11y: [
    "The label is always visible and tied to the input.",
    "With labelPlacement=\"float\" the label is still the input's real <label>, so its accessible name doesn't change; it only moves (CSS alone, no JS), keeping a long label on one line with an ellipsis.",
    "The hint and the error are linked with aria-describedby; an error sets aria-invalid and is announced.",
    "The reveal button is 44×44 px and named \"show password\" or \"hide password\".",
    "Inputs are 16 px, so phones don't zoom in.",
  ],
  keys: [["Tab", "moves to the input, then to the reveal button"]],
  dos: ["Say what is wrong and how to fix it in the error.", "Use autoCapitalize=\"none\" for usernames."],
  donts: ["Don't use the placeholder as the label.", "Don't validate on every keystroke before the person has finished."],
} satisfies ComponentPage;
