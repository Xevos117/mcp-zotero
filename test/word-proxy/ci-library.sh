#!/bin/bash
# Library variant: the cited items are real items of the test account, saved into the fresh Zotero
# database with their keys (read-only Web API calls, no sync), so the URIs resolve to library items.
# Usage: ci-library.sh ZOTERO_DIR WORDCRAFT_CLI OUTDIR   (env: ZOTERO_TEST_API_KEY, ZOTERO_TEST_USER_ID,
# optional ZOTERO_TEST_GROUP_ID; Xvfb as in ci.sh). Writes OUTDIR/report.json, or OUTDIR/skipped.
set -euo pipefail
Z=$1 WC=$2 OUT=$3
HERE="$(dirname "$(readlink -f "$0")")"
S=http://www.zotero.org/styles
D="$OUT/docs"; mkdir -p "$D"
timeout 120 node "$HERE/fetch-items.mjs" "$OUT"
user_keys=$(sed -n 's/^user=//p' "$OUT/keys.env"); group_keys=$(sed -n 's/^group=//p' "$OUT/keys.env")
if [ "$(tr ',' '\n' <<< "$user_keys" | grep -c .)" -lt 2 ]; then
  echo "test library has fewer than 2 regular items: nothing to cite" | tee "$OUT/skipped"; exit 0
fi
steps=()
WORD_PROXY_REAL=1 WORD_PROXY_KEYS="$user_keys" timeout 120 node "$HERE/gen.mjs" "$D"
steps+=("lib-user,refresh,$S/apa,$D/checklist-apa_cited.docx" "lib-user-ieee,refresh,$S/ieee,$D/checklist-ieee_cited.docx")
if [ -n "${ZOTERO_TEST_GROUP_ID:-}" ] && [ "$(tr ',' '\n' <<< "$group_keys" | grep -c .)" -ge 2 ]; then
  WORD_PROXY_REAL=1 WORD_PROXY_KEYS="$group_keys" timeout 120 node "$HERE/gen.mjs" "$D" "$ZOTERO_TEST_GROUP_ID"
  steps+=("lib-group,refresh,$S/apa,$D/checklist-apa-group_cited.docx")
fi
ZOTERO_JS_SETUP="$HERE/load-items.js" WCAUTO_ITEMS="$OUT/items.json" timeout 900 "$HERE/run.sh" "$Z" "$WC" "$OUT" "${steps[@]}"
labels=(); for s in "${steps[@]}"; do labels+=("${s%%,*}"); done
timeout 60 node "$HERE/verify.mjs" "$OUT" "${labels[@]}" > "$OUT/report.json"
node -e 'const r=require(process.argv[1]); for (const [k,v] of Object.entries(r.verdicts)) console.log(k+": "+v)' "$OUT/report.json"
