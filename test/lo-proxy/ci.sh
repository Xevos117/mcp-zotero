#!/bin/bash
# lo-proxy: injects the checklist documents of the real corpus as .odt with the built server (fake Zotero API,
# placeholder libraries users/000000 and groups/777), runs Zotero's integration commands on them through LibreOffice
# and the Zotero .oxt (UNO, driver.py), and checks every step against test/word-proxy/expect.json — the same visible
# text as the Word path, since the rendering is Zotero's. No account, no network beyond the pinned downloads.
#   session "embedded" (path B): empty Zotero library, Zotero uses the itemData embedded in each reference mark
#   session "library"  (path A): the same items loaded into the local user library and a local group 777
# Plus a docx -> LibreOffice -> docx round trip (#37): a Field .docx keeps its ZOTERO_ITEM/ZOTERO_BIBL codes and
# ZOTERO_PREF_1 after LibreOffice opens and saves it (structural check).
# Usage: ci.sh ZOTERO_DIR SOFFICE UNOPKG UNO_PYTHON OXT OUTDIR [EXPECT_JSON]   (Xvfb: XVFB=<binary>, or $DISPLAY)
set -euo pipefail
Z=$1 SOFFICE=$2 UNOPKG=$3 PY=$4 OXT=$5 OUT=$6 EXPECT=${7:-}
HERE="$(dirname "$(readlink -f "$0")")"
WP="$(dirname "$HERE")/word-proxy"
S=http://www.zotero.org/styles
D="$OUT/docs"; mkdir -p "$D"
timeout 120 node "$HERE/gen.mjs" "$D"

E="$OUT/embedded"
timeout 700 "$HERE/run.sh" "$Z" "$SOFFICE" "$UNOPKG" "$PY" "$OXT" "$E" \
  "apa,refresh,$S/apa,$D/checklist-apa_cited.odt" \
  "ieee,refresh,$S/ieee,$D/checklist-ieee_cited.odt" \
  "vancouver,refresh,$S/nlm-citation-sequence,$D/checklist-vancouver_cited.odt" \
  "harvard,refresh,$S/harvard-cite-them-right,$D/checklist-harvard_cited.odt" \
  "chicago,refresh,$S/chicago-author-date,$D/checklist-chicago_cited.odt" \
  "again,refresh,$S/apa,$E/apa.refreshed.odt" \
  "restyle,setDocPrefs,$S/chicago-author-date,$E/apa.refreshed.odt" \
  "group,refresh,$S/apa,$D/checklist-apa-group_cited.odt"

L="$OUT/library"
timeout 30 node "$WP/items.mjs" "$OUT/items.json"
ZOTERO_JS_SETUP="$WP/load-items.js" WCAUTO_ITEMS="$OUT/items.json" timeout 500 "$HERE/run.sh" "$Z" "$SOFFICE" "$UNOPKG" "$PY" "$OXT" "$L" \
  "lib-apa,refresh,$S/apa,$D/checklist-apa_cited.odt" \
  "lib-group,refresh,$S/apa,$D/checklist-apa-group_cited.odt"

# The odt checks come first and always run (a round-trip failure must not mask them): guarded, never under set -e
status=0
timeout 90 node "$HERE/verify.mjs" "$E" ${EXPECT:+--expect "$EXPECT"} apa ieee vancouver harvard chicago again restyle group > "$E/report.json" || status=1
timeout 90 node "$HERE/verify.mjs" "$L" ${EXPECT:+--expect "$EXPECT"} lib-apa lib-group > "$L/report.json" || status=1

# Round trip (#37): a Field .docx produced by the Word path, opened and saved by a separate headless LibreOffice
RT="$OUT/roundtrip"; mkdir -p "$RT/lo/user" "$RT/out"
timeout 120 node "$WP/gen.mjs" "$RT" || status=1
timeout 150 "$SOFFICE" --headless "-env:UserInstallation=file://$RT/lo" \
  --convert-to 'docx:MS Word 2007 XML' --outdir "$RT/out" "$RT/checklist-apa_cited.docx" >> "$RT/convert.log" 2>&1 || status=1
timeout 30 node "$HERE/roundtrip-check.mjs" "$RT/out/checklist-apa_cited.docx" > "$OUT/roundtrip.json" || status=1
exit $status
