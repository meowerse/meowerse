// Every /ui/components page, one record per @meowerse/ui component (registry.test.ts keeps the list complete).
import type { ReactElement } from "react";
import { toSlug } from "../lib/slug";
import type { ComponentPage, Example } from "./types";

export type RegisteredPage = ComponentPage & { slug: string };

const mods = import.meta.glob<{ default: ComponentPage }>("./components/*.tsx", { eager: true });

export const COMPONENT_PAGES: RegisteredPage[] = Object.values(mods)
  .map((m) => ({ ...m.default, slug: toSlug(m.default.name) }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function pageFor(slug: string): RegisteredPage {
  const p = COMPONENT_PAGES.find((x) => x.slug === slug);
  if (!p) throw new Error(`no component page ${slug}`);
  return p;
}

export const nodeOf = (ex: Example, scope: string): ReactElement => (typeof ex.node === "function" ? ex.node(scope) : ex.node);
