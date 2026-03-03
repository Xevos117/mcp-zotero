# Changelog

All notable changes to this project will be documented in this file.

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
