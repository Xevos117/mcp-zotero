import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse, formatEmptyResult } from "../utils/error-formatter.js";
import { fetchItemsByKeys, fetchAllPages } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { itemDoi, lookupRetraction, RetractionLookup, RetractionNotice, RetractionStatus } from "../utils/crossref-retractions.js";
import { COLLECTION_KEY_HINT, ITEM_KEY_HINT } from "../utils/error-hints.js";

const MAX_ITEM_KEYS = 50;

export const toolConfig = {
  name: "check_retractions",
  description:
    "Check whether Zotero items have been retracted, flagged with an expression of concern, or corrected. Pass EITHER item_keys (up to 50) OR collection_key, exactly one. Read-only: it never changes the library. For each item it reads the DOI (the DOI field, or a 'DOI: …' line in Extra) and looks it up on Crossref (Retraction Watch data), then reports a status: retracted, expression_of_concern, corrected, ok, no_doi (no DOI to check), not_in_crossref (the DOI is unknown to Crossref), or lookup_failed (a transient error — rerun just those). The response opens with a summary of the counts and then lists, per item, its key, title, doi, status and any notices (type, date, source, the notice's own DOI). A failed lookup never fails the rest; rerun the lookup_failed items.",
  inputSchema: {
    item_keys: z
      .array(zoteroKey())
      .max(MAX_ITEM_KEYS, `At most ${MAX_ITEM_KEYS} item keys per call`)
      .optional()
      .describe(
        'Zotero item keys to check (up to 50), e.g. ["EUHUT5K3", "F9UQM7N2"]. Provide this OR collection_key, not both. Get keys from search_library or get_collection_items.'
      ),
    collection_key: zoteroKey()
      .optional()
      .describe(
        "Check every item directly in this collection (not its subcollections). Provide this OR item_keys, not both. Get the key from get_collections."
      ),
    ...libraryArgsSchema,
  },
} as const;

const CheckRetractionsSchema = z.object(toolConfig.inputSchema);

interface ItemResult {
  key: string;
  title: string;
  doi: string | null;
  status: RetractionStatus;
  notices: RetractionNotice[];
}

export async function handleCheckRetractions(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_keys, collection_key, library_type, library_id } = CheckRetractionsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const hasKeys = item_keys !== undefined && item_keys.length > 0;
  const hasCollection = collection_key !== undefined;
  if (hasKeys === hasCollection) {
    return formatErrorResponse("Pass exactly one of item_keys or collection_key.", {
      hint: "item_keys (up to 50) checks those items; collection_key checks every item directly in a collection.",
    });
  }

  let items: ZoteroItemData[];
  let notFound: string[] = [];
  if (hasKeys) {
    const res = await fetchItemsByKeys(
      (params) => zoteroApi.library(libraryType, libraryId).items().get(params),
      item_keys!
    );
    items = res.items.filter((i) => typeof i.key === "string");
    const found = new Set(items.map((i) => i.key));
    notFound = [...new Set(item_keys!)].filter((k) => !found.has(k));
    if (items.length === 0) {
      return formatEmptyResult("No items found for the given keys", { item_keys, suggestion: ITEM_KEY_HINT });
    }
  } else {
    try {
      const { items: all } = await fetchAllPages((params) =>
        zoteroApi.library(libraryType, libraryId).collections(collection_key!).items().get(params)
      );
      items = (all ?? []).filter(
        (i) => i && typeof i.key === "string" && i.itemType !== "attachment" && i.itemType !== "note"
      );
    } catch (err) {
      if (isZoteroApiError(err) && err.response?.status === 404) {
        return formatErrorResponse(
          "Collection not found: no collection with this key in this library, or the API key cannot access it.",
          { collection_key, suggestion: COLLECTION_KEY_HINT }
        );
      }
      throw err;
    }
    if (items.length === 0) {
      return formatEmptyResult("No items to check in this collection", {
        collection_key,
        suggestion: "The collection is empty or holds only attachments and notes (those are not checked).",
      });
    }
  }

  // Crossref's polite pool: reuse the server's contact email if set (optional; Crossref works without it)
  const mailto = process.env.UNPAYWALL_EMAIL?.trim() || undefined;

  const prepared = items.map((item) => ({
    key: item.key as string,
    title: item.title || "Untitled",
    doi: itemDoi(item) ?? null,
  }));
  const withDoi = prepared.filter((p) => p.doi);
  const settled = await mapWithConcurrency(withDoi, (p) => lookupRetraction(p.doi as string, mailto));

  const lookupByKey = new Map<string, RetractionLookup>();
  withDoi.forEach((p, i) => {
    const r = settled[i];
    lookupByKey.set(p.key, r.status === "fulfilled" ? r.value : { status: "lookup_failed", notices: [] });
  });

  const results: ItemResult[] = prepared.map((p) => {
    if (!p.doi) return { key: p.key, title: p.title, doi: null, status: "no_doi", notices: [] };
    const l = lookupByKey.get(p.key) ?? { status: "lookup_failed", notices: [] };
    return { key: p.key, title: p.title, doi: p.doi, status: l.status, notices: l.notices };
  });

  const summary: Record<string, number> = { checked: results.length };
  for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1;
  const flagged = results.filter((r) => r.status === "retracted" || r.status === "expression_of_concern");

  return formatJsonResult({
    summary,
    flagged_count: flagged.length,
    ...(notFound.length ? { not_found: notFound } : {}),
    items: results,
  });
}
