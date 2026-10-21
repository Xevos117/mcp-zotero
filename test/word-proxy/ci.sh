#!/bin/bash
# Word-checklist proxy: injects the checklist docx with the built server (fake Zotero API), then runs the
# Zotero commands through WordCraft against a fresh Zotero profile and writes report.json.
# Usage: ci.sh ZOTERO_DIR WORDCRAFT_CLI OUTDIR   (Xvfb: XVFB=<binary>, or an existing $DISPLAY)
set -euo pipefail
Z=$1 WC=$2 OUT=$3
HERE="$(dirname "$(readlink -f "$0")")"
S=http://www.zotero.org/styles
D="$OUT/docs"; mkdir -p "$D"
timeout 60 node "$HERE/gen.mjs" "$D"
timeout 60 node "$HERE/gen.mjs" "$D" 777
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-apa_cited.docx" "$D/fix-apa.docx" "$S/apa"
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-ieee_cited.docx" "$D/fix-ieee.docx" "$S/ieee"
timeout 900 "$HERE/run.sh" "$Z" "$WC" "$OUT" \
  "apa,refresh,$S/apa,$D/checklist-apa_cited.docx" \
  "ieee,refresh,$S/ieee,$D/checklist-ieee_cited.docx" \
  "proposed,refresh,proposed,$D/checklist-apa_cited.docx" \
  "fix-apa,refresh,$S/apa,$D/fix-apa.docx" \
  "fix-ieee,refresh,$S/ieee,$D/fix-ieee.docx" \
  "again,refresh,$S/apa,$OUT/apa.refreshed.docx" \
  "restyle,setDocPrefs,$S/chicago-author-date,$OUT/apa.refreshed.docx" \
  "group,refresh,$S/apa,$D/checklist-apa-group_cited.docx"
timeout 60 node "$HERE/verify.mjs" "$OUT" apa ieee proposed fix-apa fix-ieee again restyle group > "$OUT/report.json"
# Second Zotero session: the same items are in the local database (user library and group 777)
timeout 30 node "$HERE/stub-items.mjs" "$OUT/items.json" 777
ZOTERO_JS_SETUP="$HERE/load-items.js" WCAUTO_ITEMS="$OUT/items.json" timeout 900 "$HERE/run.sh" "$Z" "$WC" "$OUT/library" \
  "fix-lib-user,refresh,$S/apa,$D/fix-apa.docx" \
  "lib-group,refresh,$S/apa,$D/checklist-apa-group_cited.docx"
timeout 60 node "$HERE/verify.mjs" "$OUT/library" fix-lib-user lib-group > "$OUT/library/report.json"
for r in "$OUT/report.json" "$OUT/library/report.json"; do
  node -e 'const r=require(process.argv[1]); for (const [k,v] of Object.entries(r.verdicts)) console.log(k+": "+v)' "$r"
done
