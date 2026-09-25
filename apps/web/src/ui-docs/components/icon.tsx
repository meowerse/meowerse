import { Icon, ICON_NAMES } from "@meowerse/ui";
import type { ComponentPage } from "../types";

export default {
  name: "Icon",
  summary: "A curated set of Tabler outline icons, drawn as inline SVG paths in the current text colour.",
  examples: [
    { title: "decorative", node: <Icon name="send" />, html: true },
    { title: "with a label", note: "becomes an image with a name", node: <Icon name="check" label="done" />, html: true },
    {
      title: "every icon", snippet: false,
      node: <ul className="icon-grid">{ICON_NAMES.map((n) => <li key={n}><Icon name={n} size={20} /><code>{n}</code></li>)}</ul>,
    },
  ],
  a11y: ["Decorative by default (aria-hidden); pass label to give it a name.", "Paths are elements, not innerHTML, so it renders under Trusted Types."],
  dos: ["Pair icons with text, except in 44 px icon buttons that have an aria-label."],
  donts: ["Don't use an unknown name: it renders nothing."],
} satisfies ComponentPage;
