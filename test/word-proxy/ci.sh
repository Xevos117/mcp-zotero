#!/bin/bash
# word-proxy: injects the checklist documents of the real corpus with the built server (fake Zotero API, placeholder
# libraries users/000000 and groups/777), runs Zotero's word-processor commands on them through WordCraft against a
# fresh Zotero profile, and checks every step against test/word-proxy/expect.json. No account, no network.
#   session "embedded" (path B): empty Zotero library, Zotero uses the itemData embedded in each field
#   session "library"  (path A): the same items, same keys, loaded into the local user library and a local group 777
# Usage: ci.sh ZOTERO_DIR WORDCRAFT_CLI OUTDIR [EXPECT_JSON]   (Xvfb: XVFB=<binary>, or an existing $DISPLAY)
set -euo pipefail
Z=$1 WC=$2 OUT=$3 EXPECT=${4:-}
HERE="$(dirname "$(readlink -f "$0")")"
S=http://www.zotero.org/styles
D="$OUT/docs"; mkdir -p "$D"
timeout 120 node "$HERE/gen.mjs" "$D"
# test-only stand-in for the H1 fix: the same documents with Document Preferences written in docProps/custom.xml
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-apa_cited.docx" "$D/fix-apa.docx" "$S/apa"
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-ieee_cited.docx" "$D/fix-ieee.docx" "$S/ieee"
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-apa-group_cited.docx" "$D/fix-apa-group.docx" "$S/apa"

E="$OUT/embedded"
timeout 420 "$HERE/run.sh" "$Z" "$WC" "$E" \
  "apa,refresh,$S/apa,$D/checklist-apa_cited.docx" \
  "ieee,refresh,$S/ieee,$D/checklist-ieee_cited.docx" \
  "vancouver,refresh,$S/nlm-citation-sequence,$D/checklist-vancouver_cited.docx" \
  "harvard,refresh,$S/harvard-cite-them-right,$D/checklist-harvard_cited.docx" \
  "chicago,refresh,$S/chicago-author-date,$D/checklist-chicago_cited.docx" \
  "proposed,refresh,proposed,$D/checklist-apa_cited.docx" \
  "fix-apa,refresh,$S/apa,$D/fix-apa.docx" \
  "fix-ieee,refresh,$S/ieee,$D/fix-ieee.docx" \
  "again,refresh,$S/apa,$E/apa.refreshed.docx" \
  "restyle,setDocPrefs,$S/chicago-author-date,$E/apa.refreshed.docx" \
  "group,refresh,$S/apa,$D/checklist-apa-group_cited.docx"

L="$OUT/library"
timeout 30 node "$HERE/items.mjs" "$OUT/items.json"
ZOTERO_JS_SETUP="$HERE/load-items.js" WCAUTO_ITEMS="$OUT/items.json" timeout 420 "$HERE/run.sh" "$Z" "$WC" "$L" \
  "lib-apa,refresh,$S/apa,$D/checklist-apa_cited.docx" \
  "lib-fix-apa,refresh,$S/apa,$D/fix-apa.docx" \
  "lib-group,refresh,$S/apa,$D/fix-apa-group.docx"

status=0
timeout 60 node "$HERE/verify.mjs" "$E" ${EXPECT:+--expect "$EXPECT"} \
  apa ieee vancouver harvard chicago proposed fix-apa fix-ieee again restyle group > "$E/report.json" || status=1
timeout 60 node "$HERE/verify.mjs" "$L" ${EXPECT:+--expect "$EXPECT"} lib-apa lib-fix-apa lib-group > "$L/report.json" || status=1
# path A against path B, entry by entry: what the itemData written by the product loses compared with the library
timeout 60 node "$HERE/compare.mjs" "$E/report.json" fix-apa "$L/report.json" lib-fix-apa ${EXPECT:+--expect "$EXPECT"} > "$OUT/ab.json" || status=1
exit $status
