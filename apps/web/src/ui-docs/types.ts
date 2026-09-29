import type { ReactElement } from "react";

/** One live preview. `node` renders on the server; a function gets a scope so twice-rendered nodes stay unique. */
export type Example = {
  title: string;
  node: ReactElement | ((scope: string) => ReactElement);
  /** also show the rendered HTML (for components that work without React: static markup + tokens.css) */
  html?: boolean;
  /** hide the usage snippet (e.g. the all-icons grid) */
  snippet?: false;
  /** spans the whole preview grid (headers, footers, wide grids) */
  wide?: true;
  note?: string;
};

export type ComponentPage = {
  name: string;
  from?: "@meowerse/ui" | "@meowerse/ui/cat3d";
  summary: string;
  examples: Example[];
  /** nothing to show without interaction (portals, timers): the page relies on its demo (Task 9) */
  interactiveOnly?: true;
  a11y: string[];
  keys?: [key: string, action: string][];
  dos: string[];
  donts: string[];
};
