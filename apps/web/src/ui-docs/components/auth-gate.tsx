import { AuthGate } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "AuthGate",
  summary: "Shows its children only to a signed-in user: it waits visibly, explains a failure with a retry, and sends people to sign in only on a real signed-out answer.",
  examples: [
    { title: "checking the session", note: "its first render, on the server and in the browser", node: <AuthGate base="https://auth.alxnko.dev"><p>account settings</p></AuthGate> },
  ],
  a11y: [
    "The wait is a labelled status: \"checking your session\".",
    "A failure is an alert that says what happened, with a \"try again\" button.",
    "It redirects only when the account service really answers \"signed out\", never on a timeout or a network error (B18).",
  ],
  keys: [["Tab", "reaches \"try again\" after a failure"]],
  dos: ["Wrap whole pages that need an account.", "Keep loginPath on the same origin; the return path (next=) is added for you."],
  donts: ["Don't treat a failed session check as signed out.", "Don't nest gates; use one per page."],
} satisfies ComponentPage;
