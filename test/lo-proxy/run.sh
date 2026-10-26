#!/bin/bash
# One Zotero session (fresh profile, the word-proxy test plugin) and one LibreOffice session (fresh LO profile with
# the Zotero .oxt), driving a Zotero integration command on each .odt through the extension's UNO service (driver.py).
# Usage: run.sh ZOTERO_DIR SOFFICE UNOPKG UNO_PYTHON OXT OUTDIR step...   step = label,command,style,input.odt
#   command: refresh | setDocPrefs; style: Zotero style URI for the Document Preferences answer, or "proposed"
#   output: OUTDIR/label.refreshed.odt, OUTDIR/label.pdf, OUTDIR/label.driver (driver log), OUTDIR/events.jsonl
# Env: XVFB (Xvfb binary; empty = use an existing $DISPLAY), XVFB_CWD, EXTRA_LIBS (extra library path for Zotero),
#      ZOTERO_JS_SETUP (file with JS the plugin runs before declaring itself ready, e.g. load-items.js).
set -u
Z=$1 SOFFICE=$2 UNOPKG=$3 PY=$4 OXT=$5 OUT=$6; shift 6
mkdir -p "$OUT"
P="$OUT/profile"; D="$OUT/data"; LOP="$OUT/lo-profile"
rm -rf "$P" "$D" "$LOP"; mkdir -p "$P/extensions" "$D" "$LOP/user"
HERE="$(dirname "$(readlink -f "$0")")"
PLUGIN="$(dirname "$HERE")/word-proxy/plugin"            # the shared test plugin (word-proxy/plugin)
echo "$PLUGIN" > "$P/extensions/word-proxy@mcp-zotero.test"
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
user_pref("extensions.update.enabled", false);
user_pref("extensions.zotero.retractions.enabled", false);
user_pref("extensions.zotero.sync.fulltext.enabled", false);
user_pref("extensions.zotero.reportTranslationFailure", false);
user_pref("extensions.zotero.feeds.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("extensions.wcauto.styleFile", "$OUT/next-style");
user_pref("extensions.wcauto.setup", "${ZOTERO_JS_SETUP:-}");
user_pref("extensions.wcauto.hookAlerts", true);
user_pref("extensions.zoteroOpenOfficeIntegration.skipInstallation", true);
user_pref("extensions.zotero.integration.autoRegenerate", 1);
PREFS

# LibreOffice finds the JRE the Zotero Java extension needs through JAVA_HOME (no "select a JRE" dialog)
if command -v java >/dev/null; then export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"; fi

# Disable the first-start wizard and the tip of the day in the fresh LO profile (no blocking window under Xvfb)
cat > "$LOP/user/registrymodifications.xcu" <<'XCU'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Setup/Office"><prop oor:name="FirstStartWizardCompleted" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Setup/Office"><prop oor:name="ooSetupInstCompleted" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="ShowTipOfTheDay" oor:op="fuse"><value>false</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop></item>
</oor:items>
XCU

export LD_LIBRARY_PATH="${EXTRA_LIBS:-}${EXTRA_LIBS:+:}$Z"
export MOZ_NO_REMOTE=1 MOZ_DISABLE_CONTENT_SANDBOX=1 MOZ_ALLOW_DOWNGRADE=1 MOZ_LEGACY_PROFILES=1
XPID= ; SPID=
cleanup() {
  trap - EXIT
  # SIGKILL, not SIGTERM: LibreOffice traps SIGTERM and runs a slow graceful shutdown (recovery save) that can block
  # for minutes, and a bare `wait` then hangs until the outer timeout fires (a lo-proxy job timeout). But a SIGKILL
  # to the `timeout` wrapper orphans its child, so kill the real soffice.bin (by this run's profile) and zotero-bin
  # (sessions are sequential, only one is alive) directly, then wait, bounded, for Zotero to exit — otherwise the
  # orphaned zotero-bin keeps holding the integration port and the next session cannot open 127.0.0.1:23116.
  pkill -9 -f "UserInstallation=file://$LOP" 2>/dev/null
  pkill -9 -f "zotero-bin" 2>/dev/null
  [ -n "${SPID:-}" ] && kill -9 "$SPID" 2>/dev/null
  [ -n "${ZPID:-}" ] && kill -9 "$ZPID" 2>/dev/null
  [ -n "$XPID" ] && kill -9 "$XPID" 2>/dev/null
  for _ in $(seq 1 30); do pgrep -f "zotero-bin" >/dev/null 2>&1 || break; sleep 0.2; done
}
trap cleanup EXIT

if [ -n "${XVFB:-}" ]; then
  : > "$OUT/display"
  (cd "${XVFB_CWD:-.}" && exec timeout 900 "$XVFB" -displayfd 3 -screen 0 1280x1024x24 -nolisten tcp 3> "$OUT/display") > "$OUT/xvfb.log" 2>&1 &
  XPID=$!
  timeout 15 bash -c "until [ -s '$OUT/display' ]; do kill -0 $XPID 2>/dev/null || exit 1; sleep 0.2; done" || { echo "Xvfb did not start"; exit 2; }
  export DISPLAY=":$(tr -dc '0-9' < "$OUT/display")"
fi

# Install the Zotero .oxt into the fresh LO profile before soffice starts (unopkg must not run against a live soffice)
: > "$OUT/unopkg.log"
timeout 180 "$UNOPKG" add -f "$OXT" "-env:UserInstallation=file://$LOP" >> "$OUT/unopkg.log" 2>&1 \
  || { echo "unopkg add failed"; tail -c 2000 "$OUT/unopkg.log"; exit 2; }

# Zotero: the integration comm server (127.0.0.1:23116) comes up with Zotero.Integration.init at startup
: > "$OUT/zotero.log"; T0=$(date +%s)
timeout 850 "$Z/zotero-bin" -app "$Z/app/application.ini" -profile "$P" -ZoteroDebugText >> "$OUT/zotero.log" 2>&1 &
ZPID=$!
timeout 180 bash -c "until grep -q 'WCAUTO {\"ready\"' '$OUT/zotero.log'; do kill -0 $ZPID 2>/dev/null || exit 1; sleep 0.5; done" \
  || { echo "Zotero not ready"; grep -h '^WCAUTO ' "$OUT/zotero.log" | cut -c1-300; exit 2; }
timeout 60 bash -c "until grep -q 'LibreOfficePlugin: Communication server listening on 127.0.0.1:23116' '$OUT/zotero.log'; do kill -0 $ZPID 2>/dev/null || exit 1; sleep 0.5; done" \
  || { echo "Zotero LibreOffice integration server did not open 127.0.0.1:23116"; exit 2; }
echo "Zotero ready after $(( $(date +%s) - T0 ))s"

# soffice (non-headless, needs the Xvfb display): the Zotero plugin needs a document frame
PIPE="loproxy_$$"
: > "$OUT/soffice.log"
# Not --headless/--invisible: the Zotero plugin needs a real document frame (the window is unseen, under Xvfb)
timeout 850 "$SOFFICE" "--accept=pipe,name=$PIPE;urp;" "-env:UserInstallation=file://$LOP" \
  --norestore --nologo --nodefault --nofirststartwizard >> "$OUT/soffice.log" 2>&1 &
SPID=$!

for step in "$@"; do
  IFS=, read -r label cmd style f <<< "$step"
  echo "$style" > "$OUT/next-style"
  echo "WCAUTO {\"step\":\"$label\"}" >> "$OUT/zotero.log"
  timeout 240 "$PY" "$HERE/driver.py" --pipe "$PIPE" --in "$f" \
    --out "$OUT/$label.refreshed.odt" --pdf "$OUT/$label.pdf" --command "$cmd" \
    --zotero-log "$OUT/zotero.log" --timeout 150 > "$OUT/$label.driver" 2>&1
  rc=$?
  echo "$label $cmd exit=$rc $(tail -1 "$OUT/$label.driver" 2>/dev/null)"
  if [ "$rc" -ne 0 ]; then
    # Fail fast with a clear reason and a diagnostic for the artifact: the open X windows name a modal dialog by title
    echo "::error::lo-proxy step '$label' did not complete (driver exit $rc): likely a modal dialog or a soffice/Zotero hang"
    command -v xwininfo >/dev/null 2>&1 && timeout 10 xwininfo -root -tree > "$OUT/$label.windows.txt" 2>&1 || true
  fi
done

# events.jsonl: the plugin's events (steps, dialogs, answers, loaded items, alerts) and Zotero's embedded-data
# fallbacks and missing-item prompts, in log order (same shape verify.mjs reads for word-proxy)
grep -aE '^WCAUTO |not in library\. Using embedded data|missingItem' "$OUT/zotero.log" | sed -E \
  -e 's/^WCAUTO //' \
  -e 's/^.*Item \["([^"]+)"\] not in library\. Using embedded data.*$/{"embedded":"\1"}/' \
  -e '/^\{/!s/^.*missingItem.*$/{"missingItem":true}/' > "$OUT/events.jsonl"
grep -h '"\(step\|dialog\|answer\|loaded\|alert\|setupError\)"' "$OUT/events.jsonl" | cut -c1-200
