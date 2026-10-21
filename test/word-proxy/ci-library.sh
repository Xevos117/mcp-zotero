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
# The test library changes while live-tests runs (it creates and deletes "mzt-" items): an item picked
# here can vanish before inject_citations reads it. Three attempts, then the run is skipped, not failed.
inject() {
  timeout 120 node "$HERE/fetch-items.mjs" "$OUT" || return 1
  user_keys=$(sed -n 's/^user=//p' "$OUT/keys.env"); group_keys=$(sed -n 's/^group=//p' "$OUT/keys.env")
  if [ "$(tr ',' '\n' <<< "$user_keys" | grep -c .)" -lt 2 ]; then echo "fewer than 2 regular items"; return 2; fi
  steps=()
  WORD_PROXY_REAL=1 WORD_PROXY_KEYS="$user_keys" timeout 120 node "$HERE/gen.mjs" "$D" || return 1
  steps+=("lib-user,refresh,$S/apa,$D/checklist-apa_cited.docx" "lib-user-ieee,refresh,$S/ieee,$D/checklist-ieee_cited.docx")
  if [ -n "${ZOTERO_TEST_GROUP_ID:-}" ] && [ "$(tr ',' '\n' <<< "$group_keys" | grep -c .)" -ge 2 ]; then
    WORD_PROXY_REAL=1 WORD_PROXY_KEYS="$group_keys" timeout 120 node "$HERE/gen.mjs" "$D" "$ZOTERO_TEST_GROUP_ID" || return 1
    steps+=("lib-group,refresh,$S/apa,$D/checklist-apa-group_cited.docx")
  fi
}
ok=
for attempt in 1 2 3; do
  rc=0; inject 2> "$OUT/inject.err" || rc=$?
  [ $rc -eq 0 ] && { ok=1; break; }
  [ $rc -eq 2 ] && break
  echo "attempt $attempt: injection failed ($(grep -o 'cited key(s) not found' "$OUT/inject.err" | head -1 || true)), retrying"
  sleep 20
done
if [ -z "$ok" ]; then
  echo "no stable items to cite in the test library" | tee "$OUT/skipped"; rm -f "$OUT/inject.err"; exit 0
fi
rm -f "$OUT/inject.err"
# From here on only placeholder ids (users/000000, groups/777): see scrub.mjs --ids
shopt -s nullglob
timeout 60 node "$HERE/scrub.mjs" --ids "$OUT/items.json" "$D"/*.docx
ZOTERO_JS_SETUP="$HERE/load-items.js" WCAUTO_ITEMS="$OUT/items.json" timeout 900 "$HERE/run.sh" "$Z" "$WC" "$OUT" "${steps[@]}"
labels=(); for s in "${steps[@]}"; do labels+=("${s%%,*}"); done
timeout 60 node "$HERE/verify.mjs" "$OUT" "${labels[@]}" > "$OUT/report.json"
node -e 'const r=require(process.argv[1]); for (const [k,v] of Object.entries(r.verdicts)) console.log(k+": "+v)' "$OUT/report.json"
