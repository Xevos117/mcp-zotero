// Test-only Zotero plugin (word-proxy job, never shipped): replaces Zotero's own integration windows (Document
// Preferences, citation dialog, item reselect) with scripted answers and logs every request as a `WCAUTO {json}`
// line of the debug output, so a headless run can tell which dialog Zotero wanted (H-W1) and still finish the
// command. Uses Zotero internals (Zotero.Integration.displayDialog): re-check on every Zotero update.
var orig, origAlert, windowObserver;
function log(o) { dump("WCAUTO " + JSON.stringify(o) + "\n"); }
async function startup() {
  await Zotero.initializationPromise;
  const defaultStyle = Zotero.Prefs.get("extensions.wcauto.style", true) || "http://www.zotero.org/styles/apa";
  const styleFile = Zotero.Prefs.get("extensions.wcauto.styleFile", true);
  // Style for the next Document Preferences answer: first line of styleFile (rewritten by the runner
  // before each command), else the default; "proposed" = accept what Zotero proposes (export.lastStyle)
  const nextStyle = async () => {
    let s = defaultStyle;
    if (styleFile) { try { s = (await Zotero.File.getContentsAsync(styleFile)).trim() || s; } catch (e) {} }
    return s === "proposed" ? Zotero.Prefs.get("export.lastStyle") : s;
  };
  orig = Zotero.Integration.displayDialog;
  Zotero.Integration.displayDialog = async function (url, options, io, windowType) {
    const w = io && io.wrappedJSObject ? io.wrappedJSObject : io;
    log({ dialog: url, windowType, proposedStyle: Zotero.Prefs.get("export.lastStyle"), fieldTypes: [w && w.primaryFieldType, w && w.secondaryFieldType] });
    if (/integrationDocPrefs/.test(url)) {
      const style = await nextStyle();
      log({ answer: style });
      Object.assign(w, { style, locale: "en-US", fieldType: w.primaryFieldType, useEndnotes: 0, automaticJournalAbbreviations: false, delayCitationUpdates: false });
    }
    // Any other dialog (citation, select items, bibliography editor) is cancelled: io untouched.
  };
  // LibreOffice only (lo-proxy): Session.displayAlert calls the document's displayAlert, which for the LibreOffice
  // plugin pops a UNO message box in the soffice frame and blocks the UNO-driven command forever under Xvfb. When the
  // lo-proxy runner sets extensions.wcauto.hookAlerts, log every alert and return the default button instead of
  // calling the document, so nothing blocks (verify.mjs asserts 0 alerts: a real alert still fails the run). The
  // Word path (WordCraft) never sets the pref, so Zotero.Integration.Session.displayAlert is untouched there.
  if (Zotero.Prefs.get("extensions.wcauto.hookAlerts", true) && Zotero.Integration && Zotero.Integration.Session) {
    origAlert = Zotero.Integration.Session.prototype.displayAlert;
    Zotero.Integration.Session.prototype.displayAlert = async function (text, icon, buttons) {
      log({ alert: String(text).slice(0, 200), icon, buttons });
      return 0; // default button (OK / first): never show the document's message box
    };
  }
  // Windows that bypass the word processor (e.g. Services.prompt): only logged (title, URL), never answered here;
  // the protocol's own alerts are answered by WordCraft's headless host and end up in the trace.
  windowObserver = { observe(subject) { subject.addEventListener("load", () => log({ window: subject.location.href, title: subject.document.title }), { once: true }); } };
  Services.obs.addObserver(windowObserver, "domwindowopened");
  const setup = Zotero.Prefs.get("extensions.wcauto.setup", true);
  if (setup) {
    try { await (new ((async () => {}).constructor)("Zotero", "log", await Zotero.File.getContentsAsync(setup)))(Zotero, log); }
    catch (e) { log({ setupError: String(e) }); }
  }
  log({ ready: true, zotero: Zotero.version, defaultStyle, styleFile });
}
function shutdown() {
  if (orig) Zotero.Integration.displayDialog = orig;
  if (origAlert) Zotero.Integration.Session.prototype.displayAlert = origAlert;
  if (windowObserver) Services.obs.removeObserver(windowObserver, "domwindowopened");
}
function install() {}
function uninstall() {}
