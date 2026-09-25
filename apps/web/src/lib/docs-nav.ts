// The /ui docs navigation. Each group appears once its pages exist (later tasks add theirs), and the
// /ui/ index is built from this list, so no docs link ever points at a missing page.
import { toSlug } from "./slug";

export type NavItem = { label: string; href: string };
export type NavGroup = { label: string; items: NavItem[] };

export const FOUNDATIONS: NavItem[] = [
  { label: "colours", href: "/ui/foundations/colours/" },
  { label: "type", href: "/ui/foundations/type/" },
  { label: "space, radii, layers", href: "/ui/foundations/space/" },
  { label: "motion", href: "/ui/foundations/motion/" },
  { label: "voice", href: "/ui/foundations/voice/" },
];

export function docsNav(componentNames: string[]): NavGroup[] {
  return [
    { label: "start", items: [{ label: "overview", href: "/ui/" }] },
    { label: "foundations", items: FOUNDATIONS },
    {
      label: "components",
      items: [
        { label: "all components", href: "/ui/components/" },
        ...[...componentNames].sort().map((n) => ({ label: n, href: `/ui/components/${toSlug(n)}/` })),
      ],
    },
    { label: "more", items: [{ label: "utilities", href: "/ui/utilities/" }] },
  ];
}
