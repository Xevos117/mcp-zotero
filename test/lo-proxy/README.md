# lo-proxy

The LibreOffice side of #37 decided by the real Zotero desktop: the corpus documents injected by `build/server.js`
as `.odt` (the product's ODF writer, reference marks) are refreshed by the official LibreOffice (TDF) build through
the Zotero LibreOffice integration `.oxt`, driven over UNO. Job `lo-proxy` of `test.yml`. No account and no network:
the corpus (`test/fixtures/corpus/library.json`) is served by a fake Zotero API as the placeholder libraries
`users/000000` and `groups/777`. The rendering is Zotero's, so the visible text is checked against the **same**
`test/word-proxy/expect.json` as the Word path.

| File | Role |
|---|---|
| `ci.sh` | the whole run: `gen.mjs`, two LibreOffice sessions with `run.sh`, a docx→LO→docx round trip, `verify.mjs` and `roundtrip-check.mjs` against `expect.json` |
| `gen.mjs` | checklist `.odt` documents (5 styles, plus one from the group library) injected by the built server (`format: "odt"`) with the word-proxy fake fetch |
| `run.sh` | one Zotero session (fresh profile, the shared word-proxy test plugin) + one LibreOffice session (fresh profile, the Zotero `.oxt` via `unopkg add`), one `driver.py` command per step; writes `events.jsonl` |
| `driver.py` | UNO driver (LibreOffice's bundled python): loads the `.odt`, `trigger("refresh"/"setDocPrefs")` on the extension's service, waits for Zotero's `Integration: LibreOffice-<cmd> complete` log line, stores writer8 `.odt` + PDF |
| `verify.mjs` | facts per step (reference-mark citations and their CSL JSON, visible text, ZOTERO_BIBL section, ZOTERO_PREF style/fieldType, alerts, fallbacks) and the check against `expect.json` |
| `roundtrip-check.mjs` | structural check of the docx→LO→docx round trip: the ZOTERO_ITEM/ZOTERO_BIBL field codes and ZOTERO_PREF_1 survive |

The shared pieces come from `test/word-proxy/`: the test plugin (`plugin/`, its `displayAlert` hook is enabled only
under the `extensions.wcauto.hookAlerts` pref this job sets, so the Word path is untouched), `items.mjs` +
`load-items.js` (path A, the corpus in the local database), `stub.mjs` (fake fetch) and `check-artifacts.mjs`.

Locally (Linux, Zotero and LibreOffice unpacked, a JRE and Xvfb available):

```sh
npm run build
XVFB=Xvfb timeout 780 test/lo-proxy/ci.sh <zotero-dir> <lo>/program/soffice <lo>/program/unopkg \
  <lo>/program/python <zotero-dir>/integration/libreoffice/Zotero_LibreOffice_Integration.oxt \
  /tmp/lo-proxy test/word-proxy/expect.json
```

Zotero's full debug log stays in `<out>/<session>/zotero.log` and is never uploaded. The LibreOffice version and its
sha256 (per architecture) are pinned in `.github/actions/libreoffice-tools/action.yml` and updated by hand; the
`.oxt` comes from the Zotero build that `word-tools` downloads. The driver relies on Zotero internals (the
`org.zotero.integration.ooo.ZoteroOpenOfficeIntegration` UNO service and the `Integration: LibreOffice-<cmd>
complete` debug line): re-check them on every Zotero update.
