# Changelog

All notable changes to this project will be documented in this file.

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
