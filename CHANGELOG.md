# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **`delete_items` and `delete_collection` on HTTP 412** (the library changed between the version read and the `DELETE`, e.g. a sync or another client): the tool now reads the version again, together with the keys that still exist, and retries the deletion once; keys that disappeared in the meantime are listed in `not_found`. Before, the first 412 returned `version_conflict` and nothing was deleted. A second 412 still returns `status: "version_conflict"`, now with `http_status: 412` and a `hint` to retry the call.

## [2.0.3] - 2026-10-21

### Added

- **One-click Claude Desktop extension** (`mcp-zotero.mcpb`, attached to each GitHub release): `manifest.json` (MCPB manifest 0.3) maps the Claude Desktop settings (API key stored as a sensitive value, user ID, optional library type and group ID, Unpaywall email, allowed deletions, off by default) to the server's environment variables and lists the 15 tools with one-line summaries. The bundle does not contain the Claude skills: the MCPB format has no field for them, so they stay separate release zips. `npm run bundle` builds it from a clean build with production dependencies only (about 5.5 MB); CI validates the manifest, builds the bundle and runs the stdio smoke test on the unpacked bundle, started from its manifest as a client would. `npm test` keeps the manifest in sync with `package.json` (version, entry point, Node.js version), `server.json` (environment variables) and the registered tools.
- **Official MCP Registry entry** (`server.json`, name `io.github.Xevos117/mcp-zotero`): `package.json` carries the matching `mcpName`, and the release workflow publishes `server.json` to [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) after the npm publish (GitHub OIDC login, `mcp-publisher` pinned by version and checksum). The registry checks the `mcpName` of the published npm version, so the listing starts with the first release that contains it. `npm test` validates `server.json` against the official schema and keeps its version, package name and environment variables in sync with `package.json` and the code.

### Changed

- **Placeholder text with locator, prefix and suffix**, as the chosen style renders them: `(see Smith, 2023, pp. 12–15, fig. 2)` in APA/Harvard, `(see Smith 2023, 12–15)` in Chicago, `see [1, pp. 12–15]` in IEEE; Vancouver (NLM) prints no locator. Harvard and Chicago join two authors with "and", Chicago has no comma before the year. A locator without label is a page (`12` → `p. 12`), like in Zotero.
- **Behaviour change, `get_items_details`**: the requested keys that are not in the library are listed in a `not_found` array, an extra entry of the key → metadata map (only when some are missing, without `isError`; before, they were silently left out). The name cannot collide with an item key (8 uppercase characters), but a client that iterates over every entry of the result must skip `not_found`; the skill's `inject.js` does when the result is saved as `metadata.json`.
- `search_library` rejects a `limit` below 1 or not an integer; `get_item_fulltext` rejects a negative or non-integer `max_characters` (0 still means no limit).
- `inject_citations`: a `.docx` path that does not exist on the machine running the server (typically a file in a sandbox or cloud workspace, such as code execution in Claude.ai or Claude Desktop) now returns "File not found" pointing to the `zotero-mcp-integrations` skill and its download link, instead of a bare `ENOENT`; a relative path also gets a hint to pass an absolute one. The tool description and the server instructions say when to use the skill instead of the tool, with its real name (the description called it "inject-citations skill").
- **Errors, empty results and descriptions written for the model.** Every message now says what happened, what the model can do next and, when the fix is on the user's side, what to tell the user. Zotero API, timeout and network errors that tools did not handle (before: bare text such as `403: Forbidden`) become a structured error with `http_status`, `hint` and, when present, Zotero's reason in `details`: 403 points to the key settings at zotero.org/settings/keys (library, write and group access) and to the server's settings (every user-side hint names both the extension setting and the environment variable), 429/5xx say how long to wait, a timed-out write says to check before repeating it. A deletion blocked by `UNSAFE_OPERATIONS` explains which value enables what (`items`, `all`), where to set it ("Deletions allowed" in the Claude Desktop extension's settings, or the `env` block of the MCP client config) and that the model must not work around the block. Other `hint`/`suggestion` fields: missing `UNPAYWALL_EMAIL` (once per response), full text not indexed, unknown keys, empty or attachment-only collections, numbered styles without `num`, `.docx` that is not a Word file or not writable, PDF downloads refused (by status), uploads that left an attachment record without file (now with its `item_key`). A failed Unpaywall lookup (5xx, network) no longer reads "No open access PDF found". Invalid key errors show the format and where to get keys. Descriptions: `search_library` matches title, creators and year (not "any field"); `get_collection_items` does not include subcollections; `get_items_details` leaves out keys it does not find; PDF tools mention `UNPAYWALL_EMAIL` and the Zotero storage they use (not "no cost"); delete tools ask to confirm with the user. Most error texts keep their opening words; the 404 of `get_collection_items` now says "Collection not found" (it said "Collection is empty or not accessible"), and reasons such as "No DOI" or "Item not found" are longer.

### Removed

- **`smithery.yaml`**: Smithery no longer reads it (its current documentation has no `smithery.yaml`; local stdio servers are published there as an MCPB bundle such as the `.mcpb` above). Deployments that used the `startCommand` of that file should use the npm package or the `.mcpb`.

### Fixed

- **HTML entities in DOI metadata** — doi.org / Crossref send some strings HTML-escaped (e.g. the journal "Computers &amp; Operations Research"), and `add_items_by_doi` stored them as they were, so the entity ended up in the Zotero item and in every bibliography. The resolved CSL is now decoded once (named and numeric entities; `&amp;lt;` becomes the text `&lt;`, never `<`), as plain text: nothing is parsed as HTML, and every output still escapes it where it is written (the .docx XML, the JSON field codes). Tests with hostile metadata (`<script>`, `]]>`, Word XML fragments) check that the injected document stays valid and shows the text literally.
- **No Document Preferences dialog on the first Zotero Refresh**: `inject_citations` and the skill's `inject.js` now write the Zotero document preferences into `docProps/custom.xml` (`ZOTERO_PREF_1…n`, as Zotero for Word does: the injected style, citations as Word fields), with their content type and package relationship. Before, the first Refresh opened Document Preferences proposing Zotero's last used style (in a new profile Chicago notes) instead of the injected one, and accepting it turned the citations into note-style text. A document that already has Zotero preferences is left as it is, with a warning (the first Refresh uses the style saved there); an existing custom properties part that cannot be merged into is never rewritten (warning: preferences not written); other custom properties are kept, also in a part with a namespace prefix or at the path named by the package relationship.
- **Embedded item data of book sections and other contained items**: `itemData` in the field codes (used by Zotero when the item is not in the local library, e.g. an unsynced group or a shared document) now has the container title (`bookTitle`, `proceedingsTitle`, `encyclopediaTitle`, `websiteTitle`, ...; before only `publicationTitle`) and the editors, series editors, book authors and translators (before only authors). Institutional single-field names are CSL `literal` names instead of a family name. Same in `inject.js`.
- `add_items_by_doi`: editors (and series editors, book authors, translators) from the DOI metadata are kept where the item type has them (before: authors only), and an institutional author is saved as a single-field name instead of a last name.
- **`<zcite>` keys are checked against Zotero's key format** (8 characters from `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`, like every key argument of the tools) by `inject_citations` and `inject.js`, and the error names only the invalid keys. Before, any 1-32 letters and digits were accepted (e.g. `AAAA1111`, which Zotero rejects).
- **README, Claude Code setup**: the example ran `npx tsx src/server.ts`, which works only inside a clone of the repository; it now uses `claude mcp add zotero -e ... -- npx -y @xevos117/mcp-zotero` like the other client examples.

## [2.0.2] - 2026-10-12

Fixes found by the live test suite and the agent smoke test.

### Fixed

- **Every network call is bounded** (`src/utils/timeouts.ts`): Zotero Web API requests made through `zotero-api-client` (each request gets its own `AbortSignal.timeout`), fulltext GET/PUT, upload authorization and registration: 30 s; doi.org and Unpaywall: 30 s per attempt; PDF download (body included) and upload to Zotero storage: 180 s. Before, a server that accepted the connection and never answered blocked the tool until the MCP client gave up. A timeout is reported with the operation, bound and host (e.g. `PDF download timed out after 180 s (example.org)`); `import_pdf_to_zotero` now includes the network detail for authorization, upload and registration failures.
- **`get_item_fulltext` and linked URL attachments**: a `linked_url` attachment with content type `application/pdf` was taken for a stored PDF, so the tool answered "Full text not indexed… Open the PDF in Zotero desktop", which cannot work for a web link. Stored PDFs are now preferred over links; an item (or attachment key) with only a linked PDF gets a dedicated message with the link URL.
- **Skill `inject.js`**: reads `place` (the field name returned by `get_items_details`) for `publisher-place`, so skill citations match `inject_citations` for books and reports with a place of publication. `publisherPlace` is still accepted.
- **Institutional authors in `authors`**: `search_library`, `get_collection_items` and `get_items_details` showed "No authors listed" for creators stored with a single `name` field (institutions, consortia); the name is now included.
- **`inject_citations` and the skill's `inject.js` fail the same way on bad `<zcite>` keys.** Behaviour change: `inject.js` used to print a warning for a cited key missing from `metadata.json` and still write the document, with an "Unknown, n.d." citation pointing to a nonexistent item, while `inject_citations` failed on the first unknown key with a raw `404`. A placeholder citation silently left in a thesis or paper is worse than a clear failure, so both now fail and write nothing: `inject_citations` with "N cited key(s) not found in the library: KEY1, KEY2" (every unknown key listed, no raw 404), `inject.js` with "N cited key(s) not found in the metadata: …" (exit 1). Other Zotero errors still fail as before. `inject.js` also rejects keys that are not letters and digits only (exit 1, same message as `inject_citations`) instead of writing them into the Zotero URIs.
- **No raw JSON parse errors from network responses.** `add_items_by_doi` reported an empty DOI as `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, because doi.org answers it with an HTML page (found by the agent smoke test). Empty or whitespace-only DOIs are now a validation error ("DOI must not be empty") and DOIs are trimmed; a doi.org, Unpaywall, Zotero fulltext or upload-authorization response that is not a JSON object (HTML page, empty body) gives a readable error with the HTTP status and content type, e.g. "DOI not found or not resolvable: 10.1/x (response is not a JSON object (HTTP 200, text/html))". An Unpaywall response of that kind is treated like an unavailable service: the item is created without a PDF.
- **`import_pdf_to_zotero`**: the `content_type` description now says that only PDFs are imported (the file must start with `%PDF-`) and that the value is the MIME type recorded on the attachment.

## [2.0.1] - 2026-10-11

Security and data-loss fixes. Affected: every release with these tools, including 1.0.9 and 2.0.0.

### Fixed

- **Data loss in `delete_items` with malformed item keys.** When none of the keys in an `itemKey` filter is well-formed (e.g. lowercase `zzzzzzzz`, or a typo containing `0`, `1` or `O`, which Zotero keys never contain), the Zotero Web API ignores the filter and returns the whole library. `delete_items` took those items for the requested ones and **permanently deleted** up to 50 unrelated items (deletion requires `UNSAFE_OPERATIONS=items` or `all`). For any configuration, `get_items_details` could return unrelated items and `find_and_attach_pdfs` could attach PDFs to them.
- **Path traversal through key arguments.** Keys are placed in API URL paths without encoding and `..` is resolved by URL parsing, so a crafted key (for example injected through document or PDF text) could reach other endpoints or libraries reachable with the API key: e.g. `delete_collection` with `collection_key: "../tags?tag=X&"` could remove a tag library-wide and `"../collections?collectionKey=A,B"` could delete several collections, and read tools (`get_item_fulltext`, `get_collection_items`, `find_and_attach_pdfs`) could read from other paths.
- Every key argument of every tool (`item_keys`, `item_key`, `collection_key`, `collectionKey`, `parent_item`, `parent_collection`, `collections`) is now validated against Zotero's key format (8 characters from `23456789ABCDEFGHIJKLMNPQRSTUVWXYZ`); a malformed key is a validation error before any request. Keys in `<zcite>` tags (`inject_citations`) must be letters and digits only.
- Defense in depth: item-key lookups never send malformed keys and keep only items whose key was requested; `delete_items` deletes only requested keys.

## [2.0.0] - 2026-10-10

Toolchain and dependency upgrade, plus group library support. Tool names are unchanged; the only `tools/list` differences from 1.0.9 are the optional `library_type` / `library_id` arguments and the updated `get_user_id` and `delete_items` descriptions.

### Breaking

- **Node.js >= 22 required** (was >= 18). `unpdf` 1.8 (PDF.js 6) requires Node 22 at runtime, and Node 18/20 are end-of-life. This is the only reason for the major bump: users on Node 22+ need no changes.

### Added

- **Group library support** ([#7](https://github.com/Xevos117/mcp-zotero/pull/7), by @chrisawai):
  - `ZOTERO_LIBRARY_TYPE` (`user` default, or `group`) and `ZOTERO_LIBRARY_ID` route every Zotero Web API call, the PDF upload/fulltext URLs and the citation field-code URIs (`http://zotero.org/groups/<id>/items/<key>`) to the configured library. User-library deployments are unchanged.
  - Optional per-call `library_type` / `library_id` arguments on every tool (except `get_user_id`) let one server instance target several libraries.
- **`get_items_details` returns structured `creators`** (as stored in Zotero, `firstName`/`lastName` or single-field `name`) next to the `authors` string. Additive: existing fields are unchanged. The skill's `inject.js` uses them, so its citations match `inject_citations` for multi-word surnames ("de Kroon", "Caetano da Silva"), which the `authors` string cannot represent.
- Fixes on top of #7:
  - `ZOTERO_LIBRARY_TYPE=group` without `ZOTERO_LIBRARY_ID` now fails at startup instead of silently using the user ID as a group ID; an empty `ZOTERO_LIBRARY_TYPE` means `user`; library IDs must be numeric (they are interpolated into API URLs).
  - A per-call `library_type: "group"` without `library_id` is rejected instead of reusing the user ID; `library_type: "user"` on a group server falls back to `ZOTERO_USER_ID`.
  - `get_user_id` now also returns `library_type`, `library_id` and `library_path`; the skill script `inject.js` accepts `groups/<id>` / `users/<id>` (a bare numeric ID still means a user library), so skill-generated citations point at the right library.

### Fixed

- **Tool errors now set `isError: true`** (MCP convention). Every structured error (`{ "error": ... }`) was previously returned as a normal result. Partial successes (`add_items`, `add_items_by_doi`, `find_and_attach_pdfs`, `delete_items` with `not_found`) are still normal results.
- **Empty results are no longer errors**: "No results found" / "No items found" (`search_library`), "No collections found" (`get_collections`), "Collection is empty" / "No valid items found in collection" (`get_collection_items`), "No items found for the given keys" (`get_items_details`) and "No items to process" (`find_and_attach_pdfs`) are normal results without `isError`, shaped `{ "message": ..., ...details }` (the text moved from `error` to `message`; details such as `suggestion`, `status`, `query` are unchanged).
- **Item-key lookups no longer lose items**: `get_items_details`, `delete_items` and `find_and_attach_pdfs` fetch keys in chunks of 50 with an explicit `limit`. Before, all keys went into a single request without `limit`: the API returns at most 100 items per page, so beyond 100 keys the extra items were silently dropped (`find_and_attach_pdfs` reported them as "Item not found"), and a few hundred keys made the URL so long that the API answered HTTP 500.
- **`add_items`**: results are matched to inputs by request index, so a failure no longer shifts the keys and titles of the following items; `failed[].error` is a readable `"code: message"` string; more than 50 items are written in batches of 50 (previously a 413 for the whole request).
- **`add_items_by_doi`**: a partial write failure no longer hides the items that were created. `success` lists them and `failed` adds the rejected DOIs (`{ doi, error }`) to the unresolved ones, so a retry does not duplicate them. Writes are batched by 50 as well.
- **`create_collection`, `add_linked_url_attachment`, PDF upload**: Zotero write errors are reported as text instead of `"[object Object]"`.
- **`import_pdf_to_zotero` / `find_and_attach_pdfs`**: `size_bytes` is the real file size (it was 0 whenever the PDF text was extracted).
- **`find_and_attach_pdfs`**: an item whose lookup fails (e.g. children request error) is reported with status `error` and counted, instead of disappearing from `results`. `add_items_by_doi` likewise reports a failed PDF attach in `pdf_results`.
- **Open-access PDFs found in any Unpaywall location**: `find_and_attach_pdfs` and `add_items_by_doi` reported "no PDF" whenever `best_oa_location` had no `url_for_pdf`, even if another `oa_locations` entry had one (e.g. the PLOS printable PDF of 10.1371/journal.pmed.0020124). Like Zotero Desktop, the best location is tried first, then the others in order, without duplicates. The landing-page-only message now names the real host (publisher or repository). When a PDF download fails, both tools now try the remaining locations in order (`add_items_by_doi` used to stop at the first URL); `pdf_results` reports the attached `pdf_url` or, when nothing worked, `failed_urls` with each URL and its error (`find_and_attach_pdfs` adds `failed_urls` to its `error` results).
- **Attachment filenames**: PDFs from URLs without a `.pdf` path (e.g. PLOS `/article/file?id=…`) were all named `document.pdf`. The name now comes from the URL path when it ends in `.pdf`, else from the `Content-Disposition` filename, else from the DOI (`10.1371_journal.pmed.0020124.pdf`).
- **One open-access PDF pipeline for `add_items_by_doi` and `find_and_attach_pdfs`** (`src/utils/oa-pdf.ts`): the two tools had separate copies of the lookup/download/upload logic, which is how they drifted apart (fallback URLs, messages). Both now return the same per-PDF result. Response changes:
  - added to every entry of `pdf_results` (`add_items_by_doi`) and `results` (`find_and_attach_pdfs`): `status`, `reason`, `url_used`, `filename`, `size_bytes`, `attachment_key`, `fulltext_indexed` (when attached), `failed_urls`, `landing_url`/`oa_status` where known;
  - kept for existing clients: `pdf_attached`, `pdf_url` and `error` in `pdf_results`; `pdf_url` (alias of `url_used`) in `results`;
  - `find_and_attach_pdfs`: copies reachable only through a landing page now have `status: "landing_page_only"` instead of `"not_found"` (still counted in the `not_found` total); the closed-access reason is "No open access PDF found" (the OA status stays in `oa_status`) instead of "OA status: closed";
  - `add_items_by_doi`: without a valid `UNPAYWALL_EMAIL` every item gets its own entry with the warning (was a single entry); an unexpected failure is reported on the item (`status: "error"`) instead of the top-level `pdf_attach_error`, which is no longer returned; `source: null` is omitted.
- **`delete_items` description**: it said "permanently (moves to trash)", but the Web API multi-item DELETE removes items permanently without using the Zotero trash. The description and the README now say so.
- **`inject_citations`**: the output path is derived from the file name only; a folder whose name contains `.docx` no longer produces a wrong path. `<zcite keys="A, B"/>` (space after the comma) is accepted: keys are trimmed, where the space used to end up in the item URL (404, whole injection failed).
- **Citation field codes** (`inject_citations`): the embedded `itemData` now carries `volume`, `issue`, `page`, `publisher` and `publisher-place`, no longer embeds the abstract, and drops empty fields.
- **PDF download failures name the cause**: when every URL fails, `reason` lists each host with its HTTP status or error code (`Download failed for all 1 URL(s): www.nejm.org 403`), and every `failed_urls` entry keeps the HTTP `status` when there was one. Before, a single failed URL gave only its message and several gave "Download failed for all N URL(s)".
- **`get_items_details`**: the description no longer mentions a non-existent `get_item_details` tool.
- **Skill script `inject.js`**: unknown styles are rejected (they were accepted silently), keys are trimmed, cited keys missing from `metadata.json` produce a warning, the "No authors listed" placeholder is no longer parsed as a name, and the Zotero→CSL type table matches `inject_citations`. `SKILL.md` tells Claude to copy the script as `inject.mjs` (as `.js` it fails under a `package.json` with `"type": "commonjs"`).

### Changed

- **TypeScript 7.0** (native compiler), pinned as `^7.0.2` instead of `latest`. Emitted JavaScript is byte-identical to the TypeScript 5.9 build.
  - `tsconfig.json`: explicit `"types": ["node"]` (TS 7 defaults `types` to `[]`), removed `typeRoots` (pointed at `src/types`, which is not a type-package folder) and the unused `allowJs`, added `isolatedModules` (matches how vitest transpiles each file).
- **zotero-api-client 0.48 → 0.51**: the package dropped `lib/main-node.cjs` and the `cross-fetch` polyfill in favour of the global `fetch`. The server now loads the package main entry, typed via the package's own declarations; the stale local `src/types/zotero-api-client.d.ts` augmentation was removed. Client-side request validation (added in 0.49) accepts every endpoint used by the tools.
- **unpdf 1.4 → 1.8**: `extractText({ mergePages: true })` now preserves line breaks, so text uploaded to the Zotero full-text index by `import_pdf_to_zotero` / `find_and_attach_pdfs` keeps its line structure instead of being joined with spaces.
- **dotenv 17 → 18**: no API change for `config({ quiet: true })`; dotenv now logs to stderr, so it can no longer corrupt the stdio JSON-RPC stream.
- **vitest 4 → 5**: `testTimeout`/`hookTimeout` set explicitly to 10 s. Vitest 5 clears mocks before each test by default; the suite already passes under the new default.
- Minor updates: `@modelcontextprotocol/sdk` 1.32.1, `zod` 4.6.5, `fast-xml-parser` 5.11.2, `jszip` 3.10.2, `@types/node` 26.
- `npm audit`: 0 vulnerabilities (transitive fixes for the SDK's HTTP-transport dependencies).

- **Internal: shared tool plumbing.** Duplicated code across tools was unified without changing the MCP surface (tools/list is identical): one tool registry and one wrapper that logs Zotero API errors for every tool (`src/tools/index.ts`, replacing 14 copies of the same catch/log/rethrow block); `formatJsonResult` for every JSON result; `errorMessage` for thrown values; `asArray` for single/array responses; `findPdfAttachment` shared by `get_item_fulltext` and the open-access PDF pipeline.

### CI

- `actions/checkout` and `actions/setup-node` v4 → v7.
- Tests run on Node 22, 24 and 26; release workflow uses Node 24.
- `timeout-minutes` on every job and long step.
- New `npm run smoke` step: starts `build/server.js` over stdio with fake credentials, once for a user library and once for a group library, checks `initialize`, that all 15 tools are listed with valid input schemas, and runs `get_collections` and `inject_citations` through the real `zotero-api-client` with a stubbed `fetch` that only serves the expected library (no network); the injected field code must carry the matching `users/` or `groups/` URI. This catches broken runtime imports that unit tests (which mock the client) miss.

## [1.0.8] - 2026-03-03

### Fixed

- **CSL-to-Zotero field filtering by item type** — `cslToZoteroItem()` used to send all fields (publicationTitle, ISBN, ISSN, volume, issue, pages, numPages, edition, series...) for every item type. Zotero API rejects fields not valid for a given type (e.g. `publicationTitle` on `book`, `ISBN` on `journalArticle`). The function now filters output through `ITEM_TYPE_FIELDS`, only including fields valid for the resolved item type.

- **CSL `container-title` mapped to wrong Zotero field** — Previously always mapped to `publicationTitle`. Now correctly maps to the type-specific field: `bookTitle` (bookSection), `proceedingsTitle` (conferencePaper), `blogTitle` (blogPost), `encyclopediaTitle` (encyclopediaArticle), `dictionaryTitle` (dictionaryEntry), `forumTitle` (forumPost), `websiteTitle` (webpage), `programTitle` (tvBroadcast, radioBroadcast, podcast).

- **Missing CSL type mappings from CrossRef/DataCite** — DOI content negotiation returns non-standard CSL types that were falling back to `journalArticle`. Added 15 new mappings: `journal-article`, `book-chapter` → bookSection, `proceedings-article` → conferencePaper, `posted-content` → preprint, `dissertation` → thesis, `monograph`/`edited-book`/`reference-book`/`book-series` → book, `book-part` → bookSection, `proceedings` → book, `reference-entry` → encyclopediaArticle, `report-series` → report, `component` → document, `peer-review` → journalArticle.

### Improved

- **`get_items_details` now returns all type-specific fields** — Previously returned only a fixed set (title, authors, date, DOI, publicationTitle, url). Now returns all non-empty bibliographic fields from the Zotero response (e.g. `bookTitle` for bookSection, `proceedingsTitle` for conferencePaper, `university` for thesis, `thesisType`, `volume`, `issue`, `pages`, etc.). Structural/internal fields (`key`, `version`, `dateAdded`, `dateModified`, `collections`, `tags`, `creators`) are excluded; `creators` is returned as formatted `authors` string.

- **`get_collections` filters trashed collections** — Trashed (deleted) collections are now excluded by default via client-side filtering (the Zotero API returns them regardless). Added `include_trashed` parameter (default: false) to optionally include them.

### Tests

- Added 22 new tests (382 → 404):
  - `csl-to-zotero.test.ts`: container-title mapping for 7 item types, field filtering validation for multiple types, CrossRef/DataCite non-standard type mapping (11 types), end-to-end `book-chapter` and `proceedings-article` tests.
  - `handlers.test.ts`: type-specific fields in get_items_details, structural field exclusion, get_collections trashed filtering (client-side).

## [1.0.7] - 2026-03-03

### Fixed

- **ISSN/ISBN array handling in DOI resolution** — The DOI resolver (via content negotiation) can return `ISSN` and `ISBN` as arrays (e.g. `["1234-5678"]`) instead of strings. This caused Zotero API 400 errors when creating items via `add_items_by_doi`. The `cslToZoteroItem()` converter now extracts the first element when the value is an array. The `CslItemData` type has been updated to reflect `string | string[]`.

- **`add_items_by_doi` returning `"unknown"` item keys** — When the Zotero API write response had an unexpected shape, `createdItems[i]?.key` could be `undefined`, resulting in `"unknown"` keys in the response. The handler now:
  - Checks `response.isSuccess()` before reading data, returning a detailed error on failure.
  - Validates that `getData()` returns a non-empty array.
  - Uses `response.getEntityByIndex(i)` for reliable entity access instead of raw array indexing.
  - Returns `formatErrorResponse()` for all error paths (consistent with the rest of the tool).

### Tests

- Added 5 new tests (377 → 382):
  - `csl-to-zotero.test.ts`: ISSN/ISBN as array, ISSN/ISBN as string (normal case).
  - `handlers.test.ts`: Zotero API write failure, empty API response, missing entity key.

### Credits

- Bug report and initial fix by [@luansixu](https://github.com/luansixu) ([fork](https://github.com/luansixu/mcp-zotero)).
