#!/usr/bin/env bash
# Regenerate the whole favicon set from packages/brand/mark.png and copy it into
# every app's public/ root. Run from anywhere:  bash packages/brand/scripts/build.sh
#
# Why per-app copies instead of one shared CDN URL: browser HTTP cache has been
# partitioned by top-level site since 2020 (Chrome 86 / Safari / Firefox), so a
# shared origin buys ZERO cross-site cache reuse — it only adds a third-party DNS
# + TLS handshake and a single point of failure. Worse, auth-web and meowsenger-web
# ship `default-src 'self'` CSPs, which would BLOCK a cross-origin icon outright.
# One source of truth (this package) + same-origin delivery is both faster and safer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/mark.png"
OUT="$HERE/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Brand tokens (packages/ui/src/styles/tokens.css) — kept in sync by hand.
GREEN="#00ff82"        # --mw-green / --text-accent (dark)
GREEN_DARK="#0a7a42"   # --text-accent (light): 5.5:1 on white, 3.8:1 on black
SURFACE="#0d0d0d"      # --surface-0 (dark)
EPS=0.5                # RDP tolerance; 0.5 traces the mask pixel-perfectly

mkdir -p "$OUT"

# 1. Vector trace -------------------------------------------------------------
python3 "$HERE/scripts/trace.py" "$SRC" "$TMP/path.json" "$EPS"
read -r W H D <<<"$(python3 -c "
import json;p=json.load(open('$TMP/path.json'));print(p['w'],p['h'],p['d'])")"

svg() { # svg <fill> <file>
  printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s"><path fill="%s" fill-rule="evenodd" d="%s"/></svg>' \
    "$W" "$H" "$1" "$D" > "$2"
}

# favicon.svg follows the browser theme, exactly like --text-accent does: the dark
# green stays legible on a light tab strip (the pure green is only 1.3:1 on white),
# the bright green on a dark one.
cat > "$OUT/favicon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 $W $H"><style>path{fill:$GREEN_DARK}@media(prefers-color-scheme:dark){path{fill:$GREEN}}</style><path fill-rule="evenodd" d="$D"/></svg>
SVG

svg "$GREEN_DARK" "$TMP/flat-dark.svg"   # for the .ico, which cannot adapt
svg "$GREEN"      "$TMP/flat-green.svg"  # for icons that sit on the dark surface

# 2. favicon.ico (16/32/48) ---------------------------------------------------
magick -background none "$TMP/flat-dark.svg" -resize 256x256 \
       -define icon:auto-resize=48,32,16 "$OUT/favicon.ico"

# 3. Raster icons on the brand surface ----------------------------------------
# iOS and Android composite transparent icons onto unpredictable plates, so these
# carry the surface colour themselves. `pct` is the mark's share of the canvas.
# -colors 64 palettises two flat tones plus their antialias ramp: ~4x smaller at
# an RMSE of 0.0016 (invisible). These are opaque, so no alpha is lost -- unlike
# the .ico frames, where palettising *does* wreck the edges, which is why
# favicon.ico below stays truecolour.
plate() { # plate <size> <pct> <file>
  local size=$1 pct=$2 inner
  inner=$(python3 -c "print(round($size*$pct))")
  magick -background none "$TMP/flat-green.svg" -resize "${inner}x${inner}" \
         -background "$SURFACE" -gravity center -extent "${size}x${size}" \
         -strip -colors 64 -define png:compression-level=9 "$3"
}
plate 180 0.76 "$OUT/apple-touch-icon.png"     # iOS rounds the corners itself
plate 192 0.76 "$OUT/icon-192.png"
plate 512 0.76 "$OUT/icon-512.png"
plate 512 0.60 "$OUT/icon-maskable-512.png"    # maskable safe zone = inner 80%

# 4. Distribute ---------------------------------------------------------------
# site.webmanifest is per-app (each needs its own name), so it is written by the
# loop below rather than living in icons/.
emit_manifest() { # emit_manifest <dir> <name> <short_name>
  cat > "$1/site.webmanifest" <<JSON
{
  "name": "$2",
  "short_name": "$3",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "theme_color": "$SURFACE",
  "background_color": "$SURFACE"
}
JSON
}

distribute() { # distribute <app> <name> <short_name>
  local dir="$ROOT/apps/$1/public"
  [ -d "$dir" ] || { echo "!! missing $dir" >&2; return 1; }
  cp "$OUT/favicon.svg" "$OUT/favicon.ico" "$OUT/apple-touch-icon.png" \
     "$OUT/icon-192.png" "$OUT/icon-512.png" "$OUT/icon-maskable-512.png" "$dir/"
  emit_manifest "$dir" "$2" "$3"
  echo "  -> apps/$1/public"
}

echo "distributing:"
distribute alxnko-dev      "alxnko.dev"      "alxnko"
distribute web             "meowerse"        "meowerse"
distribute auth-web        "meowerse auth"   "auth"
distribute meowsenger-web  "meowsenger"      "meowsenger"

echo
echo "generated:"
ls -l "$OUT" | awk 'NR>1 {printf "  %-26s %6s bytes\n", $9, $5}'
