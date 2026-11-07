import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse, formatEmptyResult } from "../utils/error-formatter.js";
import { fetchItemsByKeys, fetchAllPages } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { itemDoi } from "../utils/doi.js";
import { lookupRetraction, RetractionLookup, RetractionNotice, RetractionStatus } from "../utils/crossref-retractions.js";
import { isValidEmail } from "../utils/unpaywall.js";
import { COLLECTION_KEY_HINT, ITEM_KEY_HINT } from "../utils/error-hints.js";

const MAX_ITEM_KEYS = 50;
// Cap the Crossref lookups per call by the number of distinct DOIs; the rest is left for a follow-up call (start)
const MAX_LOOKUPS = 200;

export const toolConfig = {
  name: "check_retractions",
  description:
    "Check whether Zotero items have been retracted, flagged with an expression of concern, or corrected. Pass EITHER item_keys (up to 50) OR collection_key, exactly one. Read-only: it never changes the library. For each item it reads the DOI (the DOI field, or a 'DOI: …' line in Extra) and looks it up on Crossref (Retraction Watch data), then reports a status: retracted, expression_of_concern, corrected, ok, no_doi (no DOI to check), not_in_crossref (the DOI is unknown to Crossref), or lookup_failed (a transient error — rerun just those). The response opens with a summary of the counts and then lists, per item, its key, title, doi, status and any notices (type, date, source, the notice's own DOI). A failed lookup never fails the rest; rerun the lookup_failed items. At most 200 distinct DOIs are looked up per call: if the response has truncated=true, call again with start=next_start to continue (useful for a large collection).",
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
    start: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe(
        "Item offset to start from (default 0). Only needed to continue a truncated response: pass the next_start it returned."
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
  const { item_keys, collection_key, start, library_type, library_id } = CheckRetractionsSchema.parse(args);
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

  // Crossref's polite pool: reuse the server's contact email only if it is a valid address (as unpaywall.ts checks);
  // optional, Crossref works without it.
  const email = process.env.UNPAYWALL_EMAIL?.trim();
  const mailto = email && isValidEmail(email) ? email : undefined;

  const prepared = items.map((item) => ({
    key: item.key as string,
    title: item.title || "Untitled",
    doi: itemDoi(item) ?? null,
  }));

  // Cap the lookups per call by the number of DISTINCT DOIs (MAX_LOOKUPS): a large collection would otherwise make
  // thousands of Crossref requests and the MCP client could time out and lose everything. `start` is the item
  // offset; when the page fills the budget the rest is left for a follow-up call (truncated + next_start).
  const page = prepared.slice(start);
  const pageItems: typeof prepared = [];
  const uniqueDois = new Set<string>();
  let truncated = false;
  let nextStart: number | undefined;
  for (let i = 0; i < page.length; i++) {
    const p = page[i];
    if (p.doi && !uniqueDois.has(p.doi)) {
      if (uniqueDois.size >= MAX_LOOKUPS) {
        truncated = true;
        nextStart = start + i;
        break;
      }
      uniqueDois.add(p.doi);
    }
    pageItems.push(p);
  }

  // One lookup per distinct DOI (deduplicated), then remapped to every item that carries it
  const dois = [...uniqueDois];
  const settled = await mapWithConcurrency(dois, (doi) => lookupRetraction(doi, mailto));
  const byDoi = new Map<string, RetractionLookup>();
  dois.forEach((doi, i) => {
    const r = settled[i];
    byDoi.set(doi, r.status === "fulfilled" ? r.value : { status: "lookup_failed", notices: [] });
  });

  const results: ItemResult[] = pageItems.map((p) => {
    if (!p.doi) return { key: p.key, title: p.title, doi: null, status: "no_doi", notices: [] };
    const l = byDoi.get(p.doi) ?? { status: "lookup_failed", notices: [] };
    return { key: p.key, title: p.title, doi: p.doi, status: l.status, notices: l.notices };
  });

  const summary: Record<string, number> = { checked: results.length };
  for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1;
  const flagged = results.filter((r) => r.status === "retracted" || r.status === "expression_of_concern");

  return formatJsonResult({
    summary,
    flagged_count: flagged.length,
    ...(truncated ? { truncated: true, next_start: nextStart } : {}),
    ...(notFound.length ? { not_found: notFound } : {}),
    items: results,
  });
}
