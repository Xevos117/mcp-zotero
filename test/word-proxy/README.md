# word-proxy

The Word checklist hypotheses (`test/WORD_CHECKLIST.md`, H-W1…H-W5) decided by the real Zotero desktop: the
documents injected by `build/server.js` are refreshed by Zotero 10 through `wordcraft-cli`, which speaks Zotero's
word-processor protocol (the same `integration.js` logic as the Word plugin). Job `word-proxy` of `test.yml`.
No account and no network: the corpus (`test/fixtures/corpus/library.json`) is served by a fake Zotero API as the
placeholder libraries `users/000000` and `groups/777`.

| File | Role |
|---|---|
| `ci.sh` | the whole run: `gen.mjs`, two Zotero sessions with `run.sh`, `verify.mjs` and `compare.mjs` against `expect.json` |
| `gen.mjs` + `stub.mjs` | checklist documents (5 styles, plus one from the group library) injected by the built server with a fake fetch |
| `run.sh` | one Zotero session: fresh profile, the test plugin, Xvfb, one `wordcraft-cli zotero <command>` per step; writes `events.jsonl` (plugin events, embedded-data fallbacks) |
| `plugin/` | test-only Zotero plugin: records every integration dialog and answers Document Preferences with the step's style |
| `items.mjs` + `load-items.js` | path A: the corpus saved in the local Zotero database (user library and local group 777) with the same keys |
| `render.mjs` | pages of the refreshed documents as PNG and `index.json`, for the agent's visual review (job word-render) |
| `verify.mjs` | facts per step (dialogs, alerts, noteIndex, ids per URI, bibliography, style saved, fallbacks) and the check against `expect.json` |
| `compare.mjs` | path A against path B: what the product's embedded itemData loses compared with the library |
| `check-artifacts.mjs` | fail-closed check before an artifact is uploaded |
| `expect.json` | expectations per step; `knownBug` marks those that document a bug (the fix flips them) |

Locally (Linux, Zotero and WordCraft unpacked, Xvfb available):

```sh
npm run build
XVFB=Xvfb timeout 600 test/word-proxy/ci.sh <zotero-dir> <wordcraft-dir>/bin/wordcraft-cli /tmp/word-proxy test/word-proxy/expect.json
```

Zotero's full debug log stays in `<out>/<session>/zotero.log` and is never uploaded. Zotero and WordCraft versions
and their sha256 are pinned in `.github/actions/word-tools/action.yml` and updated by hand; the plugin relies on a
Zotero internal (`Zotero.Integration.displayDialog`): re-check it on every Zotero update.
