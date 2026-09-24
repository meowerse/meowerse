// Project pages (B11): typed content validated at build (content.config.ts) and by the unit tests.
import { z } from "astro/zod";

const https = z.url({ protocol: /^https$/ });

export const statusSchema = z.discriminatedUnion("kind", [
  // a live check of a public, CORS-readable endpoint (its origin becomes a connect-src entry)
  z.strictObject({ kind: z.literal("probe"), url: https, method: z.enum(["GET", "HEAD"]) }),
  // nothing public to check: say so instead of pretending (B9)
  z.strictObject({ kind: z.literal("static"), state: z.enum(["info"]), text: z.string().min(1).max(80) }),
]);

export const projectSchema = z.strictObject({
  name: z.string().min(1).max(24),
  order: z.number().int().min(1),
  service: z.boolean(),
  summary: z.string().min(10).max(110),
  what: z.array(z.string().min(10)).min(2).max(6),
  how: z.array(z.string().min(10)).min(2).max(6),
  diagram: z.strictObject({
    label: z.string().min(10),
    steps: z.array(z.strictObject({ title: z.string().min(1).max(22), note: z.string().min(1).max(34) })).min(3).max(6),
  }),
  facts: z.array(z.strictObject({ k: z.string().min(1).max(16), v: z.string().min(1).max(80) })).min(2).max(8),
  status: statusSchema,
  links: z.array(z.strictObject({ label: z.string().min(1).max(24), href: z.string().regex(/^(https:\/\/|\/)/) })).min(1).max(3),
});

export type Project = z.infer<typeof projectSchema>;
export type ProjectStatus = Project["status"];

// B13: no network, Tailscale, IP or pairing details on any page; no real name or employer on alxnko.dev.
const EVERYWHERE: readonly RegExp[] = [
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /tailscale/i, /\bderp\b/i, /\bmtu\b/i, /\bpair(?:ing|ed|s)?\b/i,
  /\bport\s*\d+/i, /\blan\b/i, /\bvpn\b/i, /wireguard/i, /\baws\b|eu-west|ireland/i, /\.internal\b|\.local\b/i,
  /\bsecret\b|password=|token=/i,
];
const ALXNKO_DEV: readonly RegExp[] = [/neko|nyrko/i, /tech lead|company|employer|linkedin|kyrgyz/i];

const strings = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/** Every forbidden pattern found in a project's copy, as "pattern in: text" lines. */
export function publicFactProblems(slug: string, p: Project): string[] {
  const rules = slug === "alxnko-dev" ? [...EVERYWHERE, ...ALXNKO_DEV] : EVERYWHERE;
  const text = strings(p);
  return rules.flatMap((re) => text.filter((t) => re.test(t)).map((t) => `${re} in: ${t}`));
}
