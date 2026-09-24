/** Component name → URL slug: "ConfirmDialog" → "confirm-dialog"; "Cat3D" → "cat3d" (no dash before a capital after a digit). */
export const toSlug = (name: string): string => name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
