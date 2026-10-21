// Test-only Zotero plugin: replaces Zotero's own integration windows (Document Preferences,
// citation dialog, item reselect) with scripted answers and logs every request, so a headless
// run can tell which dialog Zotero wanted (H-W1) and still finish the command.
var orig;
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
  // Prompts that bypass the word processor (Services.prompt): log and take the default button.
  Services.obs.addObserver({ observe(subject) { subject.addEventListener("load", () => log({ window: subject.location.href, title: subject.document.title }), { once: true }); } }, "domwindowopened");
  const setup = Zotero.Prefs.get("extensions.wcauto.setup", true);
  if (setup) {
    try { await (new ((async () => {}).constructor)("Zotero", "log", await Zotero.File.getContentsAsync(setup)))(Zotero, log); }
    catch (e) { log({ setupError: String(e) }); }
  }
  log({ ready: true, zotero: Zotero.version, defaultStyle, styleFile });
}
function shutdown() { if (orig) Zotero.Integration.displayDialog = orig; }
function install() {}
function uninstall() {}
