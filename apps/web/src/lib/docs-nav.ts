// The /ui docs navigation. Each group appears once its pages exist (later tasks add theirs), and the
// /ui/ index is built from this list, so no docs link ever points at a missing page.
export type NavItem = { label: string; href: string };
export type NavGroup = { label: string; items: NavItem[] };

export const FOUNDATIONS: NavItem[] = [
  { label: "colours", href: "/ui/foundations/colours/" },
  { label: "type", href: "/ui/foundations/type/" },
  { label: "space, radii, layers", href: "/ui/foundations/space/" },
  { label: "motion", href: "/ui/foundations/motion/" },
  { label: "voice", href: "/ui/foundations/voice/" },
];

export function docsNav(_componentNames: string[]): NavGroup[] {
  return [
    { label: "start", items: [{ label: "overview", href: "/ui/" }] },
    { label: "foundations", items: FOUNDATIONS },
    { label: "more", items: [{ label: "utilities", href: "/ui/utilities/" }] },
  ];
}
