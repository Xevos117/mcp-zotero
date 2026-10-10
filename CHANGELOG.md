# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - Unreleased

Toolchain and dependency upgrade, plus group library support. Tool names are unchanged; the only `tools/list` differences from 1.0.9 are the optional `library_type` / `library_id` arguments and the updated `get_user_id` and `delete_items` descriptions.

### Breaking

- **Node.js >= 22 required** (was >= 18). `unpdf` 1.8 (PDF.js 6) requires Node 22 at runtime, and Node 18/20 are end-of-life. This is the only reason for the major bump: users on Node 22+ need no changes.

### Added

- **Group library support** ([#7](https://github.com/Xevos117/mcp-zotero/pull/7), by @chrisawai):
  - `ZOTERO_LIBRARY_TYPE` (`user` default, or `group`) and `ZOTERO_LIBRARY_ID` route every Zotero Web API call, the PDF upload/fulltext URLs and the citation field-code URIs (`http://zotero.org/groups/<id>/items/<key>`) to the configured library. User-library deployments are unchanged.
  - Optional per-call `library_type` / `library_id` arguments on every tool (except `get_user_id`) let one server instance target several libraries.
- Fixes on top of #7:
  - `ZOTERO_LIBRARY_TYPE=group` without `ZOTERO_LIBRARY_ID` now fails at startup instead of silently using the user ID as a group ID; an empty `ZOTERO_LIBRARY_TYPE` means `user`; library IDs must be numeric (they are interpolated into API URLs).
  - A per-call `library_type: "group"` without `library_id` is rejected instead of reusing the user ID; `library_type: "user"` on a group server falls back to `ZOTERO_USER_ID`.
  - `get_user_id` now also returns `library_type`, `library_id` and `library_path`; the skill script `inject.js` accepts `groups/<id>` / `users/<id>` (a bare numeric ID still means a user library), so skill-generated citations point at the right library.

### Correzioni

- **Tool errors now set `isError: true`** (MCP convention). Every structured error (`{ "error": ... }`) was previously returned as a normal result. Partial successes (`add_items`, `add_items_by_doi`, `find_and_attach_pdfs`, `delete_items` with `not_found`) are still normal results.
- **Empty results are no longer errors**: "No results found" / "No items found" (`search_library`), "No collections found" (`get_collections`), "Collection is empty" / "No valid items found in collection" (`get_collection_items`), "No items found for the given keys" (`get_items_details`) and "No items to process" (`find_and_attach_pdfs`) are normal results without `isError`, shaped `{ "message": ..., ...details }` (the text moved from `error` to `message`; details such as `suggestion`, `status`, `query` are unchanged).
- **Item-key lookups no longer lose items**: `get_items_details`, `delete_items` and `find_and_attach_pdfs` fetch keys in chunks of 50 with an explicit `limit`. Before, all keys went into a single request without `limit`: the API returns at most 100 items per page, so beyond 100 keys the extra items were silently dropped (`find_and_attach_pdfs` reported them as "Item not found"), and a few hundred keys made the URL so long that the API answered HTTP 500.
- **`add_items`**: results are matched to inputs by request index, so a failure no longer shifts the keys and titles of the following items; `failed[].error` is a readable `"code: message"` string; more than 50 items are written in batches of 50 (previously a 413 for the whole request).
- **`add_items_by_doi`**: a partial write failure no longer hides the items that were created. `success` lists them and `failed` adds the rejected DOIs (`{ doi, error }`) to the unresolved ones, so a retry does not duplicate them. Writes are batched by 50 as well.
- **`create_collection`, `add_linked_url_attachment`, PDF upload**: Zotero write errors are reported as text instead of `"[object Object]"`.
- **`import_pdf_to_zotero` / `find_and_attach_pdfs`**: `size_bytes` is the real file size (it was 0 whenever the PDF text was extracted).
- **`find_and_attach_pdfs`**: an item whose lookup fails (e.g. children request error) is reported with status `error` and counted, instead of disappearing from `results`. `add_items_by_doi` likewise reports a failed PDF attach in `pdf_results`.
- **Open-access PDFs found in any Unpaywall location**: `find_and_attach_pdfs` and `add_items_by_doi` reported "no PDF" whenever `best_oa_location` had no `url_for_pdf`, even if another `oa_locations` entry had one (e.g. the PLOS printable PDF of 10.1371/journal.pmed.0020124). Like Zotero Desktop, the best location is tried first, then the others in order, without duplicates. The landing-page-only message now names the real host (publisher or repository).
- **Attachment filenames**: PDFs from URLs without a `.pdf` path (e.g. PLOS `/article/file?id=…`) were all named `document.pdf`. The name now comes from the URL path when it ends in `.pdf`, else from the `Content-Disposition` filename, else from the DOI (`10.1371_journal.pmed.0020124.pdf`).
- **`delete_items` description**: it said "permanently (moves to trash)", but the Web API multi-item DELETE removes items permanently without using the Zotero trash. The description and the README now say so.
- **`inject_citations`**: the output path is derived from the file name only; a folder whose name contains `.docx` no longer produces a wrong path.

### Changed

- **TypeScript 7.0** (native compiler), pinned as `^7.0.2` instead of `latest`. Emitted JavaScript is byte-identical to the TypeScript 5.9 build.
  - `tsconfig.json`: explicit `"types": ["node"]` (TS 7 defaults `types` to `[]`), removed `typeRoots` (pointed at `src/types`, which is not a type-package folder) and the unused `allowJs`, added `isolatedModules` (matches how vitest transpiles each file).
- **zotero-api-client 0.48 → 0.51**: the package dropped `lib/main-node.cjs` and the `cross-fetch` polyfill in favour of the global `fetch`. The server now loads the package main entry, typed via the package's own declarations; the stale local `src/types/zotero-api-client.d.ts` augmentation was removed. Client-side request validation (added in 0.49) accepts every endpoint used by the tools.
- **unpdf 1.4 → 1.8**: `extractText({ mergePages: true })` now preserves line breaks, so text uploaded to the Zotero full-text index by `import_pdf_to_zotero` / `find_and_attach_pdfs` keeps its line structure instead of being joined with spaces.
- **dotenv 17 → 18**: no API change for `config({ quiet: true })`; dotenv now logs to stderr, so it can no longer corrupt the stdio JSON-RPC stream.
- **vitest 4 → 5**: `testTimeout`/`hookTimeout` set explicitly to 10 s. Vitest 5 clears mocks before each test by default; the suite already passes under the new default.
- Minor updates: `@modelcontextprotocol/sdk` 1.32.1, `zod` 4.6.5, `fast-xml-parser` 5.11.2, `jszip` 3.10.2, `@types/node` 26.
- `npm audit`: 0 vulnerabilities (transitive fixes for the SDK's HTTP-transport dependencies).

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
