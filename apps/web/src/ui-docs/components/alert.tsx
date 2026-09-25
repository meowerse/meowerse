import { Alert } from "@meowerse/ui";
import type { ComponentPage } from "../types";
const noop = () => {};

export default {
  name: "Alert",
  summary: "A short message block for a success, an error or information, with an optional dismiss button.",
  examples: [
    { title: "info", node: <Alert>your recovery codes were replaced. the old ones no longer work.</Alert>, html: true },
    { title: "success", node: <Alert variant="success">saved.</Alert>, html: true },
    { title: "error", node: <Alert variant="error">wrong password — try again or reset it.</Alert>, html: true },
    { title: "dismissible", node: <Alert variant="info" onDismiss={noop}>you can revoke an app's access any time.</Alert> },
  ],
  a11y: [
    "Errors render with role=\"alert\", so screen readers announce them at once; the other variants use role=\"status\".",
    "The icon is decorative: the words carry the meaning, never the colour alone.",
    "The dismiss button is 44×44 px and is named \"dismiss\".",
  ],
  keys: [["Tab", "reaches the dismiss button"], ["Enter or Space", "dismisses the alert"]],
  dos: ["Say what happened and what to do next: \"wrong password — try again or reset it\".", "Put the alert next to what it is about."],
  donts: ["Don't show a code on its own, like \"Error 401\".", "Don't use an alert for a passing success; use a toast."],
} satisfies ComponentPage;
