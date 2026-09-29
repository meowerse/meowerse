import { Button, StatusLine } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "StatusLine",
  summary: "One line of state with a glyph and a word: [ ok ], [wait], [fail] or [info].",
  examples: [
    { title: "ok", node: <StatusLine state="ok">online</StatusLine>, html: true },
    { title: "wait", node: <StatusLine state="wait" live>connecting…</StatusLine>, html: true },
    { title: "fail, with an action", node: <StatusLine state="fail" action={<Button size="sm">retry</Button>}>offline — check your connection</StatusLine> },
    { title: "info", node: <StatusLine state="info">no public service to check</StatusLine>, html: true },
  ],
  a11y: [
    "The bracketed tag is hidden from assistive tech and a word (ok, working, error, info) is read instead.",
    "fail is an alert; with live, the other states are a polite status.",
    "Colours come from the theme tokens, so every state passes AA in both themes.",
  ],
  dos: ["Say what is happening and what to do: \"[fail] offline — retry\"."],
  donts: ["Don't use it for long text.", "Don't use the terminal (ANSI) colours for it."],
} satisfies ComponentPage;
