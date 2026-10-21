#!/bin/bash
# Second oracle: LibreOffice + Zotero's official LibreOffice plugin (bundled with Zotero) on the same
# injected docx. Needs soffice, python3-uno and a Java runtime; Xvfb as in ci.sh.
# Usage: ci-libreoffice.sh ZOTERO_DIR OUTDIR   (writes OUTDIR/*.lo.json and OUTDIR/libreoffice.json)
set -euo pipefail
Z=$1 OUT=$2
HERE="$(dirname "$(readlink -f "$0")")"
S=http://www.zotero.org/styles
D="$OUT/docs"; mkdir -p "$D"
timeout 60 node "$HERE/gen.mjs" "$D"
timeout 30 node "$HERE/add-prefs.mjs" "$D/checklist-apa_cited.docx" "$D/fix-apa.docx" "$S/apa"
export LO_PROFILE="$OUT/lo-profile"; rm -rf "$LO_PROFILE"; mkdir -p "$LO_PROFILE"
timeout 180 unopkg add -f "-env:UserInstallation=file://$LO_PROFILE" "$Z/integration/libreoffice/Zotero_LibreOffice_Integration.oxt"
timeout 60 unopkg list "-env:UserInstallation=file://$LO_PROFILE" | grep -E "Identifier|Version|is registered" | head -5
timeout 900 "$HERE/run.sh" "$Z" none "$OUT" \
  "lo-import,lo-none,$S/apa,$D/checklist-apa_cited.docx" \
  "lo-import-prefs,lo-none,$S/apa,$D/fix-apa.docx" \
  "lo-refresh,lo-refresh,$S/apa,$D/checklist-apa_cited.docx" \
  "lo-refresh-prefs,lo-refresh,$S/apa,$D/fix-apa.docx"
node -e '
const fs = require("fs"), out = process.argv[1], r = {};
for (const l of ["lo-import", "lo-import-prefs", "lo-refresh", "lo-refresh-prefs"]) {
  try { r[l] = JSON.parse(fs.readFileSync(`${out}/${l}.lo.json`, "utf8")); } catch (e) { r[l] = { missing: true }; }
}
fs.writeFileSync(`${out}/libreoffice.json`, JSON.stringify(r, null, 1));
' "$OUT"
