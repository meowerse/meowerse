import type { ReactNode } from "react";

/** Renders a prebuilt React element on the server (no hydration): the docs previews. */
export default function ReactNodeView({ node }: { node: ReactNode }) {
  return <>{node}</>;
}
