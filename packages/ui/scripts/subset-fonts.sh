#!/usr/bin/env bash
# VT323 is only used for wordmarks; JetBrains Mono's fontsource files lack arrows, box drawing,
# blocks and maths, so ship those from the upstream TTF (every glyph a 600-unit cell). Needs
# fonttools + brotli. Outputs are committed; rerun only when a wordmark or range changes.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src/assets/fonts
pyftsubset node_modules/@fontsource/vt323/files/vt323-latin-400-normal.woff2 \
  --text='meowerse_ meowsenger_ auth_ ui_' --flavor=woff2 --layout-features='' --no-hinting --desubroutinize \
  --name-IDs='' --output-file=$OUT/vt323-marks.woff2
# Record the glyphs actually present in the subsetted font's cmap, so a test can guard against a
# future --text edit silently dropping a character the wordmarks need.
python3 -c "
from fontTools.ttLib import TTFont
f = TTFont('$OUT/vt323-marks.woff2')
chars = sorted(chr(c) for c in f.getBestCmap().keys())
open('$OUT/vt323-marks.txt', 'w').write(''.join(chars))
"
SRC=${JBM_TTF:-/var/tmp/jbm/JetBrainsMono-Regular.ttf}
if [ ! -f "$SRC" ]; then
  mkdir -p "$(dirname "$SRC")"
  curl -fsSL -o "$SRC" https://github.com/JetBrains/JetBrainsMono/raw/v2.304/fonts/ttf/JetBrainsMono-Regular.ttf
fi
echo "a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f  $SRC" | sha256sum -c --quiet
pyftsubset "$SRC" \
  --unicodes='U+2190-21FF,U+2200-22FF,U+2500-259F,U+25A0-25FF' \
  --flavor=woff2 --layout-features='' --no-hinting --desubroutinize \
  --name-IDs='0,1,2,3,4,5,6,13,14' --output-file=$OUT/jetbrains-mono-symbols-400.woff2
curl -fsSL -o $OUT/OFL.txt https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/OFL.txt
