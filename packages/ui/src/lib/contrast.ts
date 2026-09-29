// WCAG 2.x contrast, and the token pairs the components really put text or UI boundaries on. One list,
// shared by the token test (scripts/gen-tokens.test.ts) and the /ui docs' contrast table.
type SemanticKey = keyof (typeof import("../../design/tokens.json"))["semantic"]["dark"];
export type ContrastPair = readonly [fg: SemanticKey, bg: SemanticKey, min: number];

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  // Non-null: `ch` is always the 3-element map of the literal 3-element array above.
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 2.x contrast ratio between two #rrggbb colours (1 to 21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** min is WCAG AA: 4.5 for text, 3 for the focus ring and input boundaries. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ["fg", "bg", 4.5], ["fg", "bgElev", 4.5], ["fg", "surface", 4.5], ["fg", "surfaceRaised", 4.5],
  ["fgMuted", "bg", 4.5], ["fgMuted", "surface", 4.5], ["fgMuted", "bgElev", 4.5], ["fgMuted", "surfaceRaised", 4.5], ["fgSubtle", "bg", 4.5], ["fgSubtle", "surface", 4.5],
  ["accent", "bg", 4.5], ["accent", "surface", 4.5], ["onAccent", "accentFill", 4.5],
  ["danger", "bg", 4.5], ["danger", "bgElev", 4.5], ["danger", "surface", 4.5], ["danger", "surfaceRaised", 4.5], ["danger", "dangerTint", 4.5], ["onDanger", "danger", 4.5],
  ["ok", "bg", 4.5], ["ok", "surface", 4.5], ["info", "bg", 4.5], ["warn", "bg", 4.5],
  ["focus", "bg", 3], ["lineInput", "bg", 3], ["lineInput", "bgElev", 3],
];
