# @meowerse/brand

The single source of truth for the site icon. `mark.png` is the master; everything
else is generated.

```bash
bash packages/brand/scripts/build.sh
```

That regenerates `icons/` and copies the set into `apps/*/public/`, where each site
serves it from its own origin root.

## Why per-app copies and not one shared CDN URL

The intuition is that pointing all four sites at one `https://…/favicon.svg` would
let the browser cache it once and reuse it everywhere. That stopped being true in
2020: Chrome 86, Safari and Firefox all **partition the HTTP cache by top-level
site**, so `alxnko.dev` and `auth.alxnko.dev` get separate cache entries for the
same URL. A shared origin buys zero reuse and costs an extra DNS lookup, TLS
handshake and a single point of failure on every site.

It would also simply not work here: `auth-web` and `meowsenger-web` ship
`default-src 'self'` CSPs, which block cross-origin icon fetches outright.

One source of truth for *maintenance* (this package) plus same-origin delivery is
both faster and safer than one source of truth for *delivery*.

## What is generated, and why each file exists

| File | Size | Purpose |
| --- | --- | --- |
| `favicon.svg` | ~6 KB (1.1 KB brotli) | What every modern browser actually uses. Crisp at any size. |
| `favicon.ico` | 15 KB | 16/32/48 fallback for legacy clients, crawlers and Windows shortcuts. |
| `apple-touch-icon.png` | 7 KB | iOS home screen (180×180). |
| `icon-192.png`, `icon-512.png` | 8 / 31 KB | Android home screen and install UI, via the manifest. |
| `icon-maskable-512.png` | 23 KB | Android adaptive shape; the mark sits inside the 80% safe zone. |
| `site.webmanifest` | — | Written per app, since each needs its own name. |

Declaring both `favicon.ico` **with `sizes="32x32"`** and `favicon.svg` is
deliberate: the explicit size is what makes SVG-capable browsers skip the `.ico`
entirely, so only legacy clients ever pay for it.

### The SVG is traced, not embedded

`scripts/trace.py` converts the PNG mask into vector contours (boundary walk +
Ramer–Douglas–Peucker). At the tolerance used, the result is **pixel-identical** to
the source (IoU 100.000%, 0 of 65 536 pixels differing) while being smaller than
the PNG and resolution-independent.

### The SVG follows the browser theme

`#00ff82` on a white tab strip is only **1.3:1** contrast — effectively invisible.
So `favicon.svg` uses the same pair the design system already defines for
`--text-accent`: `#0a7a42` in light mode (5.5:1 on white) and `#00ff82` in dark.
The `.ico` cannot adapt, so it uses `#0a7a42`, which clears 4.5:1 on white and
3.8:1 on black.

Icons that sit on a plate (`apple-touch-icon`, the manifest icons) carry
`--surface-0` dark `#0d0d0d` themselves, because iOS and Android composite
transparent icons onto backgrounds you do not control.

### No WebP or AVIF

Deliberate. No browser will pick a WebP favicon over the SVG — Safari does not
support `rel="icon"` in WebP at all — so shipping one adds bytes that nothing
requests. The SVG is already smaller than a WebP of the same mark would be.

## Changing the icon

Replace `mark.png` (square, transparent, single flat colour traces best) and rerun
the build script. If the brand colours move, update the token constants at the top
of `scripts/build.sh` to match `packages/ui/src/styles/tokens.css`.
