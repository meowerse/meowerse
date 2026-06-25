/**
 * Convert an arbitrary string into a URL-safe slug.
 *
 * Lowercases the input, replaces any run of non-alphanumeric characters
 * with a single "-", and trims leading/trailing "-".
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
