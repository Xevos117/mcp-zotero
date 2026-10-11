---
name: test-mcp-zotero
description: Smoke-test the mcp-zotero MCP server as a real user would, against a disposable Zotero test library — fixed scenario path, extra scenarios for the files a change touches, a usability assessment of the tool descriptions, and a machine-checked claims.json. Use when asked to "test mcp-zotero", run /test-mcp-zotero, or when a CI workflow says to load this skill.
---

# test-mcp-zotero — agent smoke test

You drive the `zotero` MCP server (tools `mcp__zotero__*`) through a fixed path plus targeted
scenarios, then write `agent-out/claims.json`. **A deterministic script
(`test/live/verify-claims.mjs`) decides pass/fail from your claims**, so claims must be exact: list
every object you create, with the state you expect it to have. Your prose report is informative only.

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
- Files you may write: only under `agent-out/`, with the Write tool (never through the shell). The
  only commands you may run are `node test/live/agent/make-docx.mjs …` and
  `node skills/zotero-skill-mcp-integrations/scripts/inject.js …`, from the repository root, **exactly
  in that form, one command per call**: no `timeout` prefix, no variables, no `&&`, `;`, pipes or
  redirections. The harness bounds every command and rejects anything else.

## Step 1 — Preconditions (stop if any fails)

1. Read `agent-out/context.json` (written by `test/live/agent/prepare.mjs`). It gives `run_id`,
   `run_tag`, `prefix`, `mode` (`ci`|`local`), `safe_mode`, `unsafe_operations`, `group_id`, and
   `cleanup` (`verifier` = leave everything in place for the verifier, `agent` = delete it yourself
   in step 6). If the file is missing, stop and tell the user to run
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

| ID | Scenario | Tools | What to check |
|---|---|---|---|
| F1 | Add a paper by DOI: `10.1371/journal.pcbi.1003285` into the run collection (create it first, see F2), `tags: [run_tag]`, `auto_attach_pdf: true` | `add_items_by_doi` | one item in `success`; note whether `pdf_results[0].pdf_attached` is true. doi.org/Unpaywall outages may make this `skipped` (say why) |
| F2 | Create the run collection `<prefix> agent` and a subcollection `<prefix> agent sub`; add two items with `add_items` into the run collection: a `book` with an institutional author (`{"name": "Test Consortium"}`), publisher and place, and a `journalArticle` with two authors, volume/pages/date | `create_collection`, `add_items` | keys returned in input order |
| F3 | Attachments and full text: a linked URL attachment (`https://example.org/<prefix>.pdf`, `content_type: application/pdf`) on the book; `get_item_fulltext` on the book (expect a clear "linked URL" message, not "open the PDF in Zotero desktop"); if F1 attached a PDF, `get_item_fulltext` on the F1 item (expect text) | `add_linked_url_attachment`, `get_item_fulltext` | messages and text as described |
| F4 | Find it again: `search_library` with `query = prefix` (finds the F2 items: their titles carry the prefix; DOI items keep the publisher's title); `get_collection_items` on the run collection with `excludeAttachments: false`; `get_items_details` on all created regular items | `search_library`, `get_collection_items`, `get_items_details` | F2 items found by search; every created regular item listed in the collection; details carry `creators` |
| F5 | `inject_citations`: create `agent-out/<prefix>-paper.docx` with `make-docx.mjs` (paragraphs: single citation of the article, multi-key citation article+book, citation of the F1 item with `locator: "p. 3"` and `prefix: "see "`), then inject with `style: "apa"` | `inject_citations` | `citations_found` = `citations_injected` = 3; output `agent-out/<prefix>-paper_cited.docx` |
| F6 | Same document through the product skill: write the `get_items_details` JSON to `agent-out/metadata.json` (Write tool), run `node skills/zotero-skill-mcp-integrations/scripts/inject.js agent-out/<prefix>-paper.docx agent-out/<prefix>-paper_skill.docx agent-out/metadata.json <library_path> apa` | `get_items_details`, inject.js | exit 0, no WARNING; both documents claimed with the same `compare_group` |
| F7 | Only if `group_id` is set: `get_user_id` with `library_type: "group"`, `library_id: group_id`; `add_items` one book into the group (tags as usual); `inject_citations` with the same per-call library args on a one-citation docx | the above, per call | URIs are `http://zotero.org/groups/<id>/items/<key>`. Without `group_id` report `skipped` |
| F8 | Deletion: `add_items` one throwaway book (`<prefix> to delete`), then `delete_items` it | `add_items`, `delete_items` | `deleted_count: 1`; claim it under `deleted`, not `created` |

`make-docx.mjs` usage (run from the repository root):

```sh
node test/live/agent/make-docx.mjs agent-out/<prefix>-paper.docx '[["As shown ", {"zcite": {"keys": "ARTICLEKEY"}}, "."], ["Both ", {"zcite": {"keys": "ARTICLEKEY,BOOKKEY"}}], ["See ", {"zcite": {"keys": "DOIKEY", "locator": "p. 3", "prefix": "see "}}]]'
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
| `src/citation-injector/**`, `src/tools/inject-citations.ts` | T-inject | inject the F5 document again with `ieee` (add `num` attributes: 1, "1,2", 3) and `harvard` |
| `skills/zotero-skill-mcp-integrations/**` | T-skill | inject.js with `ieee` on the numbered document; compare with `inject_citations` (`compare_group`) |
| `src/utils/library-context.ts`, `src/server.ts`, `src/tools/index.ts` | T-library | per-call `library_type: "user"` + own `library_id` on two read tools; if `group_id`: repeat F7 reads |
| `src/utils/timeouts.ts`, `src/utils/fetch-retry.ts` | T-network | run F1 and T-import (if not already run); every call must return (success or a clear error) |

## Step 4 — Usability assessment

For each tool you used, answer: did its description lead you to the right call (arguments, order,
library override) at the first attempt? Note friction: misleading descriptions, unclear errors,
surprising defaults. Put them in `friction` in claims.json (tool + one sentence each).

## Step 5 — Claims (`agent-out/claims.json`)

Write exactly this structure (JSON, no comments):

```json
{
  "schema_version": 1,
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
    { "path": "agent-out/<prefix>-paper_cited.docx", "producer": "inject_citations", "style": "apa", "library_path": "users/123", "compare_group": "paper-apa" },
    { "path": "agent-out/<prefix>-paper_skill.docx", "producer": "inject.js", "style": "apa", "library_path": "users/123", "compare_group": "paper-apa" }
  ],
  "friction": [{ "tool": "get_item_fulltext", "note": "…" }]
}
```

- `created`: every collection, item and attachment this run created that still exists (PDF
  attachments created by `add_items_by_doi` count: list them if the tool returned their key; otherwise
  claim `has_pdf: true` on the parent). Only put `expect` fields you are sure of.
- `has_pdf: true` only if the tool reported the PDF as attached.
- `deleted`: everything you deleted with `delete_items`/`delete_collection`.

## Step 6 — Cleanup and final report

- If `context.cleanup` is `agent` (local runs): delete everything you created with `delete_items`
  (items before collections; children go with their parent). Collections: `delete_collection` only if
  `unsafe_operations` is `all` and not safe mode; otherwise list them in the report so the user can run
  `npm run test:live:cleanup -- <run_id>`.
  Move the deleted keys from `created` to `deleted` in claims.json.
- If `context.cleanup` is `verifier` (CI): delete nothing beyond F8; the workflow verifies your claims
  and then removes the run.
- Finish with a short report: scenarios with status, friction, anything surprising. When the harness
  asks for structured output, fill it from the same data.

## Running it locally

1. Build the server: `npm run build`.
2. Create a local, uncommitted `.mcp.json` (it is gitignored) pointing at the **test** account. Claude
   Code expands `${VAR}` from your environment, so the key never lands in the file:

   ```json
   {
     "mcpServers": {
       "zotero": {
         "command": "node",
         "args": ["build/server.js"],
         "env": {
           "ZOTERO_API_KEY": "${ZOTERO_TEST_API_KEY}",
           "ZOTERO_USER_ID": "${ZOTERO_TEST_USER_ID}",
           "UNSAFE_OPERATIONS": "items",
           "UNPAYWALL_EMAIL": "${UNPAYWALL_EMAIL}"
         }
       }
     }
   }
   ```

3. `node test/live/agent/prepare.mjs --mode local` (add `ZOTERO_LIVE_SAFE_MODE=1` against a personal
   library), then run `/test-mcp-zotero` in Claude Code.
4. Verify: `ZOTERO_TEST_API_KEY=… node test/live/verify-claims.mjs`.
