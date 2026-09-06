#!/usr/bin/env bash
# shot.sh <page?query> <out.png> <W> <H> [scale=1] [budget=5000]  (Vite must already be on :5211)
set -euo pipefail
URL="http://localhost:5211/$1"; OUT="$2"; W="$3"; H="$4"; SCALE="${5:-1}"; BUDGET="${6:-5000}"
/usr/bin/google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor="$SCALE" --virtual-time-budget="$BUDGET" --window-size="${W},${H}" \
  --enable-logging=stderr --v=0 --screenshot="$OUT" "$URL" 2>&1 | grep -o 'HARNESS_METRICS .*' | sed 's/", source:.*//' | head -1 || true
[ -s "$OUT" ] && echo "screenshot -> $OUT"
