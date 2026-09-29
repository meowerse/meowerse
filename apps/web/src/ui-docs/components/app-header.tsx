import { AppHeader } from "@meowerse/ui";
import type { ComponentPage } from "../types";

// The live preview passes links that resolve on this docs site; the auth app's real destinations
// (about, developers, docs, log in, sign up, account) are documented in the props table's default
// column instead of rendered here, since they 404 on meow.alxnko.dev.
const previewLinks = {
  guest: [
    { label: "about", href: "/ui/" },
    { label: "developers", href: "/ui/components/" },
    { label: "docs", href: "/ui/" },
  ],
  guestActions: [
    { label: "log in", href: "/#projects" },
    { label: "sign up", href: "/#projects" },
  ],
  signedIn: [
    { label: "account", href: "/" },
    { label: "developers", href: "/ui/components/" },
    { label: "docs", href: "/ui/" },
  ],
};

export default {
  name: "AppHeader",
  summary: "The header of meowerse accounts: brand, navigation that follows the session, the theme toggle, and a menu button on phones.",
  examples: [
    { title: "checking the session", note: "session-dependent links wait", wide: true, node: <AppHeader session={{ loading: true, authenticated: false }} links={previewLinks} /> },
    { title: "signed out", wide: true, node: <AppHeader session={{ loading: false, authenticated: false }} links={previewLinks} /> },
    { title: "signed in", wide: true, node: <AppHeader session={{ loading: false, authenticated: true, username: "alxnko", verified: true }} links={previewLinks} /> },
    { title: "session check failed", note: "no false \"log in\"", wide: true, node: <AppHeader session={{ loading: false, authenticated: false, error: "network" }} links={previewLinks} /> },
  ],
  a11y: [
    "The brand link is named \"meowerse auth — home\".",
    "The phone menu button reports aria-expanded; the navigation opens below the header.",
    "While the session is loading or failed, the header never offers \"log in\" to someone who may already be signed in (B9).",
  ],
  keys: [["Tab", "moves through the links, the theme toggle and the menu button"], ["Enter or Space", "opens or closes the phone menu"]],
  dos: [
    "Pass the session from useSession(base), so every island on the page shares one request.",
    "Pass your own links prop; the live preview above points at this docs site's own pages, not the auth app's real destinations (see the props table's default column for those).",
  ],
  donts: ["Don't use it outside meowerse accounts yet: its brand is fixed. A configurable header comes with the accounts redesign (sub-project 3)."],
} satisfies ComponentPage;
