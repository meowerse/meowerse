import type { Scalar } from "../../lib/playground-state";

/** Components in the playground and their starting values (plain data: the server builds the controls from it). */
export const SEEDS: Record<string, Record<string, Scalar>> = {
  Button: { children: "save" },
  Badge: { children: "verified" },
  Alert: { children: "wrong password — try again or reset it." },
  StatusLine: { children: "connecting…" },
  Field: { label: "username" },
  Checkbox: { label: "remember this device" },
  Card: { title: "profile", children: "signed in as alxnko." },
  Avatar: { name: "alxnko" },
  Spinner: {},
  Kbd: { children: "Enter" },
  Wordmark: {},
  Code: { value: "meow.alxnko.dev" },
  Prompt: { label: "message", value: "see you at 7" },
};
