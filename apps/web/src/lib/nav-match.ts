/**
 * Whether `pathname` is inside the section a nav entry points at. Shared by `site.ts` and the e2e
 * nav check (`tests/e2e/shell.spec.ts`): this file has zero imports, so both Vite/Vitest and
 * Node's native ESM loader (Playwright's test runner) can load it directly — unlike `site.ts`,
 * which pulls in `@meowerse/ui/tokens.json` and can't be imported from a Playwright test file
 * (Node rejects a bare JSON import without an explicit `type: "json"` attribute).
 */
export const isCurrent = (pathname: string, match: string): boolean => pathname.startsWith(match);
