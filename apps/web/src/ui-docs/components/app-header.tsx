import { AppHeader } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "AppHeader",
  summary: "The header of meowerse accounts: brand, navigation that follows the session, the theme toggle, and a menu button on phones.",
  examples: [
    { title: "checking the session", note: "session-dependent links wait", wide: true, node: <AppHeader session={{ loading: true, authenticated: false }} /> },
    { title: "signed out", wide: true, node: <AppHeader session={{ loading: false, authenticated: false }} /> },
    { title: "signed in", wide: true, node: <AppHeader session={{ loading: false, authenticated: true, username: "alxnko", verified: true }} /> },
    { title: "session check failed", note: "no false \"log in\"", wide: true, node: <AppHeader session={{ loading: false, authenticated: false, error: "network" }} /> },
  ],
  a11y: [
    "The brand link is named \"meowerse auth — home\".",
    "The phone menu button reports aria-expanded; the navigation opens below the header.",
    "While the session is loading or failed, the header never offers \"log in\" to someone who may already be signed in (B9).",
  ],
  keys: [["Tab", "moves through the links, the theme toggle and the menu button"], ["Enter or Space", "opens or closes the phone menu"]],
  dos: ["Pass the session from useSession(base), so every island on the page shares one request."],
  donts: ["Don't use it outside meowerse accounts yet: its brand and links are fixed. A configurable header comes with the accounts redesign (sub-project 3)."],
} satisfies ComponentPage;
