import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { COLLECTION_KEY_HINT } from "../utils/error-hints.js";
import { asArray } from "../utils/pagination.js";
import { firstCreatorName } from "../utils/item-formatter.js";
import { itemDoi, normalizeDoi } from "../utils/doi.js";
import { normalizeTitle, itemYear, titleSubgroups, isTitleLongEnough } from "../utils/duplicates.js";

/** Items per page; 100 is the real Web API maximum for a multi-object request. */
const SCAN_PAGE = 100;
/** Cap on the number of regular items scanned, so one call never walks an unbounded library. Reported as `truncated`. */
const MAX_SCAN_ITEMS = 5000;

export const toolConfig = {
  name: "find_duplicates",
  description: `Find duplicate items in your Zotero library. Read-only: it never merges, edits or deletes anything — it only reports candidates for the user to resolve.

Two modes:
- With 'dois' (up to 50): checks which of those DOIs are ALREADY in the library. Returns, per DOI, the matching items (item_key, title, year, first author, type). Run this before add_items_by_doi and skip the DOIs that already have an entry, to avoid creating duplicates.
- Without 'dois': scans the library (or a single collection) for duplicate groups — items that share a normalized DOI, or a normalized title (ignoring case, accents and punctuation; same year required when both items have one; very short/generic titles skipped). Each group lists its items so the user decides which to keep.

Only regular items are scanned: notes, attachments and the trash are skipped, up to 5000 items (in both modes). The result reports 'scanned' (regular items examined) and 'truncated' (true if the cap was hit before the end; in 'dois' mode a DOI past the cap may then be missed). Pass 'collection_key' to limit the scan to one collection.`,
  inputSchema: {
    dois: z
      .array(z.string().trim().min(1, "DOI must not be empty"))
      .max(50, "Pass at most 50 DOIs per call")
      .optional()
      .describe(
        'Optional: check these DOIs (bare or as https://doi.org/… URLs, up to 50) against the library and return, per DOI, the items already present. Use before add_items_by_doi. Omit to scan for duplicate groups instead.'
      ),
    collection_key: zoteroKey()
      .optional()
      .describe("Optional: limit the scan to the items directly in this collection (from get_collections). Omit to scan the whole library."),
    ...libraryArgsSchema,
  },
} as const;

const FindDuplicatesSchema = z.object(toolConfig.inputSchema);

/** One item in the tool output: the fields the user needs to tell duplicates apart and act on them. */
interface DuplicateEntry {
  key: string | null;
  title: string;
  year: string | null;
  first_author: string | null;
  item_type: string | null;
  doi: string | null;
}

function toEntry(item: ZoteroItemData): DuplicateEntry {
  return {
    key: item.key ?? null,
    title: item.title || "Untitled",
    year: itemYear(item),
    first_author: firstCreatorName(item.creators),
    item_type: item.itemType ?? null,
    doi: itemDoi(item),
  };
}

/** Add a value to the list stored under `key`, creating the list on first use. */
function pushGroup<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Walk the regular items of a library or collection, 100 per page, up to MAX_SCAN_ITEMS. `.top()` excludes
 * child notes/attachments and the trash; standalone notes/attachments are dropped here too. The page length
 * (not the filtered count) advances the offset, so server-side paging stays correct.
 */
async function scanRegularItems(
  buildRequest: (params: Record<string, unknown>) => ReturnType<ZoteroApiInterface["get"]>
): Promise<{ items: ZoteroItemData[]; scanned: number; truncated: boolean }> {
  const items: ZoteroItemData[] = [];
  let start = 0;
  let total: number | null = null;
  let truncated = false;

  for (;;) {
    const response = await buildRequest({ limit: SCAN_PAGE, start });
    if (total === null) total = response.getTotalResults();
    const page = asArray(response.getData());
    if (page.length === 0) break;

    for (const item of page) {
      if (item.itemType !== "attachment" && item.itemType !== "note") items.push(item);
    }
    start += page.length;

    if (start >= MAX_SCAN_ITEMS) {
      truncated = total === null ? page.length === SCAN_PAGE : start < total;
      break;
    }
    if (total !== null && start >= total) break;
    if (total === null && page.length < SCAN_PAGE) break;
  }

  return { items, scanned: items.length, truncated };
}

export async function handleFindDuplicates(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { dois, collection_key, library_type, library_id } = FindDuplicatesSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const buildRequest = (params: Record<string, unknown>) => {
    const library = zoteroApi.library(libraryType, libraryId);
    const scope = collection_key ? library.collections(collection_key).items() : library.items();
    return scope.top().get(params);
  };

  let items: ZoteroItemData[];
  let scanned: number;
  let truncated: boolean;
  try {
    ({ items, scanned, truncated } = await scanRegularItems(buildRequest));
  } catch (err) {
    if (collection_key && isZoteroApiError(err) && err.response?.status === 404) {
      return formatErrorResponse(
        "Collection not found: no collection with this key in this library, or the API key cannot access it.",
        { collection_key, suggestion: COLLECTION_KEY_HINT, status: "not_found" }
      );
    }
    throw err;
  }

  const byKey = (a: DuplicateEntry, b: DuplicateEntry) => (a.key ?? "").localeCompare(b.key ?? "");

  if (dois) {
    const byDoi = new Map<string, ZoteroItemData[]>();
    for (const item of items) {
      const doi = itemDoi(item);
      if (doi) pushGroup(byDoi, doi, item);
    }
    // Deterministic output: results follow the input DOI order, each `existing` sorted by key.
    const results = dois.map((raw) => {
      const normalized = normalizeDoi(raw);
      const existing = normalized ? byDoi.get(normalized) ?? [] : [];
      return { doi: raw, normalized, existing: existing.map(toEntry).sort(byKey) };
    });
    return formatJsonResult({ mode: "dois", scanned, truncated, dois: results });
  }

  const groups: Array<{ match: "doi" | "title"; key: string; items: DuplicateEntry[] }> = [];

  // DOI duplicates first: a shared DOI is the strongest signal, so those items are excluded from the title pass.
  const byDoi = new Map<string, ZoteroItemData[]>();
  for (const item of items) {
    const doi = itemDoi(item);
    if (doi) pushGroup(byDoi, doi, item);
  }
  const doiGroupedKeys = new Set<string>();
  for (const [doi, group] of byDoi) {
    if (group.length < 2) continue;
    for (const item of group) if (item.key) doiGroupedKeys.add(item.key);
    groups.push({ match: "doi", key: doi, items: group.map(toEntry) });
  }

  const byTitle = new Map<string, ZoteroItemData[]>();
  for (const item of items) {
    if (item.key && doiGroupedKeys.has(item.key)) continue;
    const title = normalizeTitle(item.title);
    if (!isTitleLongEnough(title)) continue;
    pushGroup(byTitle, title, item);
  }
  for (const [title, bucket] of byTitle) {
    if (bucket.length < 2) continue;
    for (const subgroup of titleSubgroups(bucket)) {
      if (subgroup.length >= 2) groups.push({ match: "title", key: title, items: subgroup.map(toEntry) });
    }
  }

  // Deterministic order: DOI groups before title groups, then by key.
  groups.sort((a, b) => (a.match === b.match ? a.key.localeCompare(b.key) : a.match === "doi" ? -1 : 1));
  for (const group of groups) group.items.sort(byKey);

  return formatJsonResult({ mode: "scan", scanned, truncated, duplicate_groups: groups.length, groups });
}
