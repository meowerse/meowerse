/** Spread onto an <a>: adds data-astro-prefetch="hover" only when a `prefetch` predicate is given and accepts the href. Renders nothing extra otherwise. */
export function prefetchProps(prefetch: ((href: string) => boolean) | undefined, href: string): { "data-astro-prefetch"?: "hover" } {
  return prefetch?.(href) ? { "data-astro-prefetch": "hover" } : {};
}
