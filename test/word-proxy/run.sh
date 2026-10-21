#!/bin/bash
# Zotero (fresh profile, test plugin) + wordcraft-cli refresh on each docx given.
# Usage: run.sh ZOTERO_DIR WORDCRAFT_CLI OUTDIR step...   step = label,command,style,input.docx
#   (command: refresh|setDocPrefs|addEditBibliography; style: Zotero style URI or "proposed" for the
#   Document Preferences answer; output: OUTDIR/label.refreshed.docx, OUTDIR/label.trace)
# Env: XVFB (Xvfb binary; empty = use an existing $DISPLAY), XVFB_CWD, EXTRA_LIBS, STYLE (Zotero style URI),
#      ZOTERO_JS_SETUP (optional file with JS the plugin runs before declaring itself ready).
set -u
Z=$1 WC=$2 OUT=$3; shift 3
mkdir -p "$OUT"; P="$OUT/profile"; D="$OUT/data"; rm -rf "$P" "$D"; mkdir -p "$P/extensions" "$D"
HERE="$(dirname "$(readlink -f "$0")")"
echo "$HERE/plugin" > "$P/extensions/wc-auto@poc.local"     # extension proxy file -> unpacked plugin
cat > "$P/user.js" <<PREFS
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.zotero.dataDir", "$D");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.wcauto.style", "${STYLE:-http://www.zotero.org/styles/apa}");
user_pref("extensions.wcauto.styleFile", "$OUT/next-style");
user_pref("extensions.wcauto.setup", "${ZOTERO_JS_SETUP:-}");
PREFS
export LD_LIBRARY_PATH="${EXTRA_LIBS:-}${EXTRA_LIBS:+:}$Z"
export MOZ_NO_REMOTE=1 MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_ALLOW_DOWNGRADE=1 MOZ_LEGACY_PROFILES=1
XPID=
cleanup() { [ -n "${ZPID:-}" ] && kill "$ZPID" 2>/dev/null; [ -n "$XPID" ] && kill "$XPID" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT
if [ -n "${XVFB:-}" ]; then
  (cd "${XVFB_CWD:-.}" && exec timeout 600 "$XVFB" :99 -screen 0 1280x1024x24 -nolisten tcp) > "$OUT/xvfb.log" 2>&1 &
  XPID=$!
  timeout 15 bash -c 'until [ -e /tmp/.X11-unix/X99 ]; do sleep 0.3; done' || { echo "Xvfb did not start"; exit 2; }
  export DISPLAY=:99
fi
: > "$OUT/zotero.log"; T0=$(date +%s)
timeout 500 "$Z/zotero-bin" -app "$Z/app/application.ini" -profile "$P" -ZoteroDebugText >> "$OUT/zotero.log" 2>&1 &
ZPID=$!
# Ready = plugin logged WCAUTO ready (after Zotero init, LibreOffice socket open, optional setup done)
timeout 180 bash -c "until grep -q 'WCAUTO {\"ready\"' '$OUT/zotero.log'; do kill -0 $ZPID 2>/dev/null || exit 1; sleep 0.5; done" \
  || { echo "Zotero not ready"; tail -5 "$OUT/zotero.log"; exit 2; }
echo "Zotero ready after $(( $(date +%s) - T0 ))s"
for step in "$@"; do
  IFS=, read -r label cmd style f <<< "$step"
  echo "$style" > "$OUT/next-style"
  echo "WCAUTO {\"step\":\"$label\"}" >> "$OUT/zotero.log"
  timeout 120 "$WC" zotero "$cmd" "$f" --save "$OUT/$label.refreshed.docx" --trace > "$OUT/$label.trace" 2>&1
  echo "$label $cmd exit=$? calls=$(grep -c '^←' "$OUT/$label.trace") $(tail -2 "$OUT/$label.trace" | head -1 | cut -c1-120)"
done
grep -h "WCAUTO\|Using embedded data" "$OUT/zotero.log" | cut -c1-300
