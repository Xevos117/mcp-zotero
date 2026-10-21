---
name: test-mcp-zotero
description: Smoke-test the mcp-zotero MCP server as a real user would, against a disposable Zotero test library — fixed scenario path (inject_citations ⇄ inject.js parity in every style, edge cases), extra and up to 5 exploratory scenarios for what a change touches, a usability assessment of the tool descriptions, and a machine-checked claims.json. Use when asked to "test mcp-zotero", run /test-mcp-zotero, or when a CI workflow says to load this skill.
---

# test-mcp-zotero — agent smoke test

You drive the `zotero` MCP server (tools `mcp__zotero__*`) through a fixed path, targeted and
exploratory scenarios, then write `agent-out/claims.json`. **A deterministic script
(`test/live/verify-claims.mjs`) decides pass/fail from your claims and from an audit log of every
call you make**, written by hooks you cannot see or change, so claims must be exact: list every object
you create, with the state you expect it to have, and every call exactly as you made it. Your prose
report is informative only.

**The environment is already set up.** The `zotero` MCP server is configured by whoever started this
session (the CI workflow, or the local command in `test/live/agent/README.md`) against the right
library. Never configure, add or modify MCP servers or settings; if `mcp__zotero__*` tools are missing,
that is a failed precondition (step 1), not something to fix.

Budget: about 120–150 turns (about 20 of them for the rendered pages of step 5b). Batch where the tools allow it (one `add_items` call for several items,
one `make-docx.mjs` call for several outputs) and do not re-read files you just wrote.

## Rules (always)

- **Only touch what this run creates.** Every title starts with the run prefix (`context.prefix`,
  e.g. `mzt-mv46v04m-2fb3 …`), every item gets the tag `context.run_tag` (pass `tags` on every write
  tool that accepts it) and goes into the run collection. Never modify, attach to, or delete an item or
  collection you did not create in this run. Never touch anything named or tagged with "Tesi", "tesi"
  or "laurea".
- **Never print secrets.** Do not echo API keys, emails or environment variables. You do not need
  them: the MCP server already has its configuration.
- **Timeouts.** If a tool call does not return (your harness times it out), record the scenario as
  `failed` with the tool name and move on. Do not retry more than once.
- **On any error, continue** with the next scenario and report it. Never stop the whole run because
  one scenario failed (except the preconditions in step 1).
- Files you read (`agent-out/diff.txt`, `context.json`, docx outputs' JSON, the rendered pages in
  `agent-render/`): always with the Read tool, never with `head`, `cat` or other shell commands (denied, and a
  wasted turn). For a long file use Read's `offset`/`limit`. `agent-render/` is read-only for you.
- Files you may write: only under `agent-out/`, with the Write tool (never through the shell). The
  only commands you may run are `node test/live/agent/make-docx.mjs …` and
  `node test/live/agent/inject.mjs …` (a wrapper around the product skill's `inject.js` that keeps every path inside `agent-out/`), from the repository root, **exactly
  in that form, one command per call**: no `timeout` prefix, no variables, no `&&`, `;`, pipes or
  redirections, paths only as `agent-out/<name>`, the make-docx spec in single quotes. A hook denies
  anything else, and deletions of keys this run did not create; a denial outside step F0 is reported.

## Step 1 — Preconditions (stop if any fails)

1. Read `agent-out/context.json` (written by `test/live/agent/prepare.mjs`). It gives `run_id`,
   `run_tag`, `prefix`, `mode` (`ci`|`local`), `safe_mode`, `unsafe_operations`, `group_id`, and
   `cleanup` (`verifier` = leave everything in place for the verifier, `agent` = delete it yourself
   in step 7). If the file is missing, stop and tell the user to run
   `node test/live/agent/prepare.mjs --mode local`.
2. The server exposes exactly **15** `mcp__zotero__*` tools.
3. `get_user_id` answers; note `library_path` (e.g. `users/123`).
4. `get_collections`: a collection named `__mzt_disposable__` must exist (it marks a disposable test
   library), **unless** `safe_mode` is true. In safe mode you are in a personal library: use only
   `delete_items` on items you created, never `delete_collection`, never a group.
5. If any precondition fails, write `claims.json` with scenario `P0` = `failed` and the reason, and
   stop. Otherwise record `P0` = `passed`.

## Step 2 — Fixed path (every run)

Use these exact scenario IDs. Keep the keys returned by each tool; you will need them for claims.
Below, `ARTICLE`, `BOOK`, `MEMO` are the F2 item keys, `DOIKEY` the F1 item (use `ARTICLE` if F1 was
skipped), `<style>` each of `apa`, `harvard`, `chicago`, `ieee`, `vancouver`.

| ID | Scenario | Tools | What to check |
|---|---|---|---|
| F0 | Guardrails (do this first, exactly): run the Bash command `node test/live/agent/make-docx.mjs agent-out/<prefix>-probe.docx '[["probe"]]' && ls` and call `delete_items` with `item_keys: ["XXXXXXXX"]` | Bash, `delete_items` | both are **denied** by the harness hooks (the reason starts with "Denied by the agent smoke harness"); passed if both were denied, failed if either ran |
| F1 | Add a paper by DOI: `10.1371/journal.pcbi.1003285` into the run collection (create it first, see F2), `tags: [run_tag]`, `auto_attach_pdf: true` | `add_items_by_doi` | one item in `success`; note whether `pdf_results[0].pdf_attached` is true. doi.org/Unpaywall outages may make this `skipped` (say why) |
| F2 | Create the run collection `<prefix> agent` and a subcollection `<prefix> agent sub`; add three items with one `add_items` call into the run collection: `BOOK` = a `book` with an institutional author (`{"name": "Test Consortium"}`), publisher and place; `ARTICLE` = a `journalArticle` titled `<prefix> Über «Lernen» – 学习 ✓` by `Jürgen Müller-Ødegård` and `Zoë Ångström`, with volume/pages/date; `MEMO` = a `report` titled `<prefix> undated memo` with **no date and no creators** | `create_collection`, `add_items` | keys returned in input order |
| F3 | Attachments and full text: a linked URL attachment (`https://example.org/<prefix>.pdf`, `content_type: application/pdf`) on the book; `get_item_fulltext` on the book (expect a clear "linked URL" message, not "open the PDF in Zotero desktop"); if F1 attached a PDF, `get_item_fulltext` on the F1 item (expect text) | `add_linked_url_attachment`, `get_item_fulltext` | messages and text as described |
| F4 | Find it again: `search_library` with `query = prefix` (finds the F2 items: their titles carry the prefix; DOI items keep the publisher's title); `get_collection_items` on the run collection with `excludeAttachments: false`; `get_items_details` on all created regular items | `search_library`, `get_collection_items`, `get_items_details` | F2 items found by search; every created regular item listed in the collection; details carry `creators` |
| F5 | Parity document, `inject_citations` side. Two `make-docx.mjs` calls (specs below): the author-date spec to `agent-out/<prefix>-p-apa.docx agent-out/<prefix>-p-harvard.docx agent-out/<prefix>-p-chicago.docx`, the numbered spec to `agent-out/<prefix>-p-ieee.docx agent-out/<prefix>-p-vancouver.docx`. Then `inject_citations` on each `<prefix>-p-<style>.docx` with its `style` (5 calls) | `inject_citations` | each: `citations_found` = `citations_injected` = 5, no `warnings`; output `agent-out/<prefix>-p-<style>_cited.docx` |
| F6 | Parity document, `inject.js` side: write the `get_items_details` result for `DOIKEY`, `ARTICLE`, `BOOK`, `MEMO` **verbatim** (the JSON text the tool returned, unchanged) to `agent-out/metadata.json` (Write tool), then for each style `node test/live/agent/inject.mjs agent-out/<prefix>-p-<style>.docx agent-out/<prefix>-p-<style>_skill.docx agent-out/metadata.json <library_path> <style>` (5 calls) | `get_items_details`, inject.js | each: exit 0, `found` = `injected` = 5, no WARNING. Claim both documents of a style with `compare_group: "parity-<style>"` and `source: "agent-out/<prefix>-p-<style>.docx"`: the verifier requires identical field JSON (except the random `citationID`), visible text and bibliography |
| F7 | Only if `group_id` is set: `get_collections` with `library_type: "group"`, `library_id: group_id` (`get_user_id` takes no library arguments: it always describes the server's own library); `add_items` one book into the group (tags as usual); `make-docx.mjs` a one-citation `agent-out/<prefix>-group.docx`; `inject_citations` on it with the same per-call library args, and `inject.mjs` with library `groups/<group_id>` and the group `get_items_details` result written verbatim to `agent-out/group-metadata.json` | the above, per call | URIs are `http://zotero.org/groups/<id>/items/<key>`; both documents claimed with `compare_group: "parity-group"`. Without `group_id` report `skipped` |
| F8 | Deletion: `add_items` one throwaway book (`<prefix> to delete`), then `delete_items` it | `add_items`, `delete_items` | `deleted_count: 1`; claim it under `deleted`, not `created` |
| F9 | `<zcite>` edge cases, both producers, `style: "apa"` (specs below): (a) `agent-out/<prefix>-edge.docx` with `keys="ARTICLE, BOOK"` (space after the comma) and `keys="ARTICLE,ARTICLE"`; (b) `agent-out/<prefix>-nozcite.docx` without any `<zcite>`; (c) `agent-out/<prefix>-badkey.docx` with the traversal key `../items`; (d) `agent-out/<prefix>-unknown.docx` citing `ARTICLE` and the unknown well-formed key `ZZZZZZZZ`. Run `inject_citations` and `inject.mjs` (same `metadata.json`) on each | `inject_citations`, inject.js | (a) both inject 2 citations, claim both with `compare_group: "edge"`; (b) both report 0 found and write an unchanged copy, claim both with `compare_group: "nozcite"`; (c) both reject it with `Invalid Zotero item key(s) in <zcite>`; (d) both fail on the unknown key: `inject_citations` with `1 cited key(s) not found in the library: ZZZZZZZZ`, inject.js with `1 cited key(s) not found in the metadata: ZZZZZZZZ`. (c) and (d): `inject_citations` as an error, inject.js with exit 1, no output written, nothing to claim |
| F10 | Tool-input edge cases, exactly these calls: `delete_items` with `item_keys: []`; with 50 times `"ZZZZZZZZ"`; with 51 times `"ZZZZZZZZ"`; `add_items` with `items: []`; `get_items_details` with `item_keys: []` and with `item_keys: ["   "]`; `search_library` with `query: "   "`, `limit: 1`; `search_library` with `query = prefix` and `limit` 1, 100 and 101 | the above | `[]` and 51 keys: validation errors; 50 keys: accepted, nothing deleted; `items: []` and `"   "`: validation errors; whitespace-only query: a result, as without a query; limits 1/100/101: at most 1/100/100 results, never an error. Every result readable: no crash, no `undefined`/`NaN`/`[object Object]`, no stack trace |

`make-docx.mjs` takes one or more output paths and the spec last (run from the repository root). A run
is plain text, `{"zcite": {...}}` (own run), `{"zcite": {...}, "before": "…", "after": "…"}` (inline,
mid-sentence) or `{"zcite": {...}, "split": true}` (the tag split across three runs, as Word does).
Replace the placeholders with the real keys:

```sh
# F5 author-date spec (apa, harvard, chicago)
node test/live/agent/make-docx.mjs agent-out/<prefix>-p-apa.docx agent-out/<prefix>-p-harvard.docx agent-out/<prefix>-p-chicago.docx '[["Single ", {"zcite": {"keys": "ARTICLE"}}, "."], ["Multi ", {"zcite": {"keys": "ARTICLE,BOOK"}}], ["Locator ", {"zcite": {"keys": "DOIKEY", "locator": "pp. 12-15", "prefix": "see ", "suffix": ", emphasis added"}}], [{"zcite": {"keys": "MEMO"}, "before": "As the memo ", "after": " shows, inline."}], ["Split ", {"zcite": {"keys": "BOOK,MEMO"}, "split": true}, " end."]]'
# F5 numbered spec (ieee, vancouver): the same with num on every tag
node test/live/agent/make-docx.mjs agent-out/<prefix>-p-ieee.docx agent-out/<prefix>-p-vancouver.docx '[["Single ", {"zcite": {"keys": "ARTICLE", "num": "1"}}, "."], ["Multi ", {"zcite": {"keys": "ARTICLE,BOOK", "num": "1,2"}}], ["Locator ", {"zcite": {"keys": "DOIKEY", "num": "3", "locator": "pp. 12-15", "prefix": "see ", "suffix": ", emphasis added"}}], [{"zcite": {"keys": "MEMO", "num": "4"}, "before": "As the memo ", "after": " shows, inline."}], ["Split ", {"zcite": {"keys": "BOOK,MEMO", "num": "2,4"}, "split": true}, " end."]]'
# F9
node test/live/agent/make-docx.mjs agent-out/<prefix>-edge.docx '[["Spaced ", {"zcite": {"keys": "ARTICLE, BOOK"}}], ["Duplicated ", {"zcite": {"keys": "ARTICLE,ARTICLE"}}]]'
node test/live/agent/make-docx.mjs agent-out/<prefix>-unknown.docx '[["Known ", {"zcite": {"keys": "ARTICLE"}}], ["Unknown ", {"zcite": {"keys": "ZZZZZZZZ"}}]]'
node test/live/agent/make-docx.mjs agent-out/<prefix>-nozcite.docx '[["No citations here."]]'
node test/live/agent/make-docx.mjs agent-out/<prefix>-badkey.docx '[["Bad ", {"zcite": {"keys": "../items"}}]]'
```

## Step 3 — Targeted path (files the change touches)

Read `agent-out/diff.txt` (changed files and patch). For every row whose pattern matches a changed
file, run its extra scenario once (IDs `T-…`). Skip rows that need permissions you do not have
(`delete_collection` requires `unsafe_operations: all` and is never allowed in safe mode).

| Changed files | ID | Extra scenario |
|---|---|---|
| `src/tools/search-library.ts` | T-search | `search_library` without query, each `sort` with `limit: 3`, `direction` asc/desc; empty query result is a message, not an error |
| `src/tools/get-collections.ts`, `src/tools/get-collection-items.ts`, `src/utils/pagination.ts` | T-collections | `get_collections` with `include_trashed`; `get_collection_items` on the subcollection (empty → message) and with `excludeAttachments: false` (the linked attachment appears) |
| `src/tools/get-items-details.ts`, `src/utils/item-formatter.ts` | T-details | `include_abstract: true`; unknown key mixed with known keys |
| `src/tools/get-item-fulltext.ts`, `src/utils/zotero-fulltext.ts`, `src/utils/attachments.ts` | T-fulltext | `max_characters: 10` on an item with text; attachment key directly; unknown key → "Item not found" |
| `src/tools/add-items.ts`, `src/utils/csl-to-zotero.ts`, `src/utils/zotero-item-types.ts`, `src/utils/write-results.ts` | T-add-items | `add_items` with `bookSection` (editor), `thesis`, `conferencePaper`; one invalid field for the type must be rejected with a readable message |
| `src/tools/add-items-by-doi.ts`, `src/utils/doi-resolver.ts` | T-doi | one valid + one nonexistent DOI (`10.0000/<prefix>`) → partial success; DOI in `https://doi.org/…` form |
| `src/tools/import-pdf-to-zotero.ts`, `src/utils/pdf-uploader.ts`, `src/utils/pdf-text-extractor.ts` | T-import | `import_pdf_to_zotero` of `https://journals.plos.org/ploscompbiol/article/file?id=10.1371/journal.pcbi.1003285&type=printable` as a child of the article; then `get_item_fulltext` returns text |
| `src/tools/find-and-attach-pdfs.ts`, `src/utils/oa-pdf.ts`, `src/utils/unpaywall.ts` | T-find | `find_and_attach_pdfs` on the run collection with `dry_run: true`: `processed` equals the regular items in it |
| `src/tools/add-linked-url-attachment.ts` | T-link | standalone linked attachment in both run collections |
| `src/tools/delete-items.ts`, `src/tools/delete-collection.ts`, `src/utils/unsafe-operations.ts` | T-delete | `delete_items` with one own key + `ZZZZZZZZ` → `not_found`; if `unsafe_operations` is `all` and not safe mode: `delete_collection` on the subcollection |
| `src/citation-injector/**`, `src/tools/inject-citations.ts` | T-inject | `ieee` on the author-date document (no `num`): both producers warn about the missing `num` and write `[?]`; claim them with `compare_group: "nonum-ieee"` |
| `skills/zotero-skill-mcp-integrations/**` | T-skill | inject.js with the bare numeric user id instead of `users/<id>` on the apa document: same URIs; claim it, and the `inject_citations` apa document a second time, with `compare_group: "bare-id"` |
| `src/utils/library-context.ts`, `src/server.ts`, `src/tools/index.ts` | T-library | per-call `library_type: "user"` + own `library_id` on two read tools; if `group_id`: repeat F7 reads |
| `src/utils/timeouts.ts`, `src/utils/fetch-retry.ts` | T-network | run F1 and T-import (if not already run); every call must return (success or a clear error) |

## Step 4 — Exploratory scenarios (max 5)

Design **up to 5** extra scenarios `X1`…`X5` that probe the robustness of **what this change touches**:
read `agent-out/diff.txt`, pick the tools, arguments or code paths it modifies, and try the inputs a
careless caller would send: `null`, missing or wrong-type values, empty strings and arrays,
whitespace, very long strings, unicode, boundary numbers (0, negative, huge, fractional), duplicates,
valid and invalid values mixed in one call. Example: the diff changes the input of
`add_items_by_doi` → send `dois: ["", "  ", null]`, a 2000-character DOI, a DOI with unicode, a valid
and an invalid DOI together. If the diff touches no tool (docs, CI only), pick the tools closest to it
or run none and say so in the report.

- Same rules as everything else: only data this run creates (prefix and run tag on every title you
  write), respect `safe_mode` and `unsafe_operations`, never more than 5 scenarios.
- Never pass a malformed or foreign key to a **write** tool (`add_*`, `import_pdf_to_zotero`,
  `find_and_attach_pdfs` without `dry_run`, `create_collection`, `delete_*`): malformed keys made
  Zotero ignore the filter and return the whole library in 2.0.0. Probe key validation with read tools
  (`get_items_details`, `get_item_fulltext`, `get_collection_items`) or with `ZZZZZZZZ` / `YYYYYYYY`.
- Expected behaviour: a readable result or a readable error with `isError`; never a crash, a closed
  connection, a stack trace, `[object Object]`, or a raw `undefined`/`NaN` in the text.
- Verdict per scenario: `ok` (behaves as expected), `bug` (crash, data touched that should not be,
  silently wrong result, unreadable error), `unclear` (debatable behaviour worth a human look). **A
  `bug` fails the check**; `unclear` is shown as a warning.
- Record each call by its audit number, never by re-typing its arguments: after every Zotero tool call and
  Bash command the audit hook adds a note to the tool result (hook additional context) that reads
  `audit call_no N (<tool>): reference this call in claims.json as "call_no": N`. Write
  `{"tool": "<tool>", "call_no": N, "is_error": true|false}` (`is_error`: whether that call returned an
  error); for inject.js the tool is `"Bash"`. The verifier looks the number up in the audit log and checks
  the tool and the outcome; each call belongs to one scenario only, and the calls of the fixed path (F9,
  F10) are not exploratory: make new ones. The report shows each call's input as the audit recorded it.
  If no call carries that note (hooks that do not number calls), record the calls exactly as sent instead:
  `{"tool": "<tool>", "args": {...}}` (for inject.js `{"tool": "Bash", "args": {"command": "<the exact command>"}}`).

The verifier also scans **every** Zotero tool result of the run, fixed path included, for the
failures listed above, so a crash anywhere fails the check whatever you claim.

## Step 5 — Usability assessment

For each tool you used, answer: did its description lead you to the right call (arguments, order,
library override) at the first attempt? Note friction: misleading descriptions, unclear errors,
surprising defaults. Put them in `friction` in claims.json (tool + one sentence each).

## Step 5b — Visual review of the rendered pages (`agent-out/visual-review.md`)

If `agent-render/index.json` does not exist (a local run without rendered pages), skip this step and write
no `visual-review.md`. Otherwise `agent-render/` holds PNG pages of documents that Zotero 10 desktop really refreshed (job word-render):
the checklist document of the real corpus (`test/fixtures/corpus`) injected by the product in every style
(path B: Zotero renders from the `itemData` the product embedded), the same document from the group library,
the H-W1 case `proposed` (the user pressed OK on the Document Preferences dialog Zotero opened, accepting
the style it proposed), and `lib-fix-apa` (path A: the same items from the local library, the reference).
Read `agent-render/index.json` first (document, style, path, page of each image, the dialog recorded at that
step, the 12 corpus items with their cases, the known issues), then every PNG with the Read tool.

The pages are **WordCraft's rendering, not Word's**. Judge the **content** of the citations and of the
bibliography, per style: which elements are there (authors, year, title, container, editors as "In … (Ed.)",
publisher, pages, DOI), their order, italics where the style wants them, numbering in numeric styles
(`ieee`, `vancouver`), locators and prefixes ("see", "p. 110"), disambiguation (co-authors, 2020a/2020b),
non-Latin text and name particles. Compare path B with path A (`lib-fix-apa`) for the same item. Do **not**
judge layout (fonts, hanging indents, line spacing, margins, page breaks): note it only in the
"Da verificare in Word" list, which never fails the run.

Write `agent-out/visual-review.md` (Write tool) exactly in this format. One section per content problem:

```markdown
# Revisione visiva

## Problema 1: <short title>
- Documento: <document of index.json, e.g. apa>
- Pagina: <image of index.json, e.g. apa-p2.png>
- Posizione: <exact place: "voce di bibliografia 3", "paragrafo 5, seconda citazione">
- Voce del corpus: <corpus id from index.json, e.g. eve2020>[, <another id>]
- Reso: "<the rendered text, quoted>"
- Atteso: "<what the style requires>"
- Noto: <id of a known issue of index.json>   (only if the problem is that known issue)

## Da verificare in Word
- <layout remark> (<image>)
```

If nothing in the content is wrong, write only `# Revisione visiva` and the line
`Nessun problema di contenuto.` (plus the "Da verificare in Word" list, if any).

Read **every** page listed in index.json: the harness records each Read of `agent-render/*.png`, and if a page is
missing when you finish, it stops you once or twice with the list (read those pages, update the review), then
the verifier fails the run. Report every known issue you see with its `Noto`; the known issues marked
`reportsRequired` (the itemData differences, item by item) must all be reported: they are visible on the path B
pages and prove the review was done. A known issue covers only its own steps and `items`. Every document whose index
entries have a `dialog` is H-W1 (Zotero asked for Document Preferences on its first Refresh): one problem per such
document, describing the dialog (title and proposed style) and quoting the citations that are not in the
document's style (on `proposed`, the note-style text), with `Noto: H-W1` if index.json lists H-W1 as a known
issue, without it otherwise (then it is a regression). The verifier checks that every page, document, corpus id and known issue
you reference exists; a content problem without `Noto` fails the run as a bug, so mark a known issue only
when it is really that issue. Read the known issues of index.json before writing: some describe what a style or
the corpus data does on purpose (e.g. no locator in NLM citations, title case on an item without language).

## Step 6 — Claims (`agent-out/claims.json`)

Write exactly this structure (JSON, no comments):

```json
{
  "schema_version": 2,
  "run_id": "<context.run_id>",
  "library_path": "users/123",
  "scenarios": [{ "id": "F1", "status": "passed|failed|skipped", "notes": "short reason, required for failed/skipped" }],
  "created": [
    { "kind": "collection", "key": "ABCD1234", "library_path": "users/123", "expect": { "parent_collection": "WXYZ5678" } },
    { "kind": "item", "key": "EFGH5678", "library_path": "users/123", "expect": { "title": "<exact title>", "collection": "ABCD1234", "doi": "10.1371/…", "has_pdf": true } },
    { "kind": "attachment", "key": "IJKL9012", "library_path": "users/123", "expect": { "parent_item": "EFGH5678", "link_mode": "linked_url" } }
  ],
  "deleted": [{ "kind": "item", "key": "MNOP3456", "library_path": "users/123" }],
  "docx": [
    { "path": "agent-out/<prefix>-p-apa_cited.docx", "producer": "inject_citations", "style": "apa", "library_path": "users/123", "source": "agent-out/<prefix>-p-apa.docx", "compare_group": "parity-apa" },
    { "path": "agent-out/<prefix>-p-apa_skill.docx", "producer": "inject.js", "style": "apa", "library_path": "users/123", "source": "agent-out/<prefix>-p-apa.docx", "compare_group": "parity-apa" }
  ],
  "exploratory": [
    { "id": "X1", "rationale": "one line tied to the diff", "calls": [{ "tool": "add_items_by_doi", "call_no": 42, "is_error": false }], "expected": "…", "observed": "…", "verdict": "ok|bug|unclear" }
  ],
  "friction": [{ "tool": "get_item_fulltext", "note": "…" }]
}
```

- `created`: every collection, item and attachment this run created that still exists (PDF
  attachments created by `add_items_by_doi` count: list them if the tool returned their key; otherwise
  claim `has_pdf: true` on the parent). Only put `expect` fields you are sure of.
- `has_pdf: true` only if the tool reported the PDF as attached.
- `deleted`: everything you deleted with `delete_items`/`delete_collection`.
- `docx`: every document produced in F5, F6, F7, F9 and T-rows, each with its `source` (the
  `make-docx.mjs` output it was injected from) and `compare_group`. Ten parity entries (5 styles × 2
  producers), two `parity-group` entries if F7 ran, two `edge` and two `nozcite` entries (never the
  F0 probe document).
- `exploratory`: the scenarios of step 4 (empty array if none).

## Step 7 — Cleanup and final report

- If `context.cleanup` is `agent` (local runs): delete everything you created with `delete_items`
  (items before collections; children go with their parent). Collections: `delete_collection` only if
  `unsafe_operations` is `all` and not safe mode; otherwise list them in the report so the user can run
  `npm run test:live:cleanup -- <run_id>`.
  Move the deleted keys from `created` to `deleted` in claims.json.
- If `context.cleanup` is `verifier` (CI): delete nothing beyond F8; the workflow verifies your claims
  and then removes the run.
- Finish with a short report: scenarios with status, exploratory findings, visual problems, friction,
  anything surprising. When the harness asks for structured output, fill it from the same data.

## Running it outside CI

See `test/live/agent/README.md` (how the session is started, with the same MCP configuration, tool
set and hooks as CI). Nothing in this skill changes: it always assumes the environment is ready.
