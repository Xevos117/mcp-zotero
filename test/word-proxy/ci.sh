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
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-apa_cited.docx" "$D/fix-apa.docx" "$S/apa"
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-ieee_cited.docx" "$D/fix-ieee.docx" "$S/ieee"
timeout 900 "$HERE/run.sh" "$Z" "$WC" "$OUT" \
  "apa,refresh,$S/apa,$D/checklist-apa_cited.docx" \
  "ieee,refresh,$S/ieee,$D/checklist-ieee_cited.docx" \
  "proposed,refresh,proposed,$D/checklist-apa_cited.docx" \
  "fix-apa,refresh,$S/apa,$D/fix-apa.docx" \
  "fix-ieee,refresh,$S/ieee,$D/fix-ieee.docx" \
  "again,refresh,$S/apa,$OUT/apa.refreshed.docx" \
  "restyle,setDocPrefs,$S/chicago-author-date,$OUT/apa.refreshed.docx"
timeout 60 node "$HERE/verify.mjs" "$OUT" apa ieee proposed fix-apa fix-ieee again restyle > "$OUT/report.json"
node -e 'const r=require(process.argv[1]); for (const [k,v] of Object.entries(r.verdicts)) console.log(k+": "+v)' "$OUT/report.json"
