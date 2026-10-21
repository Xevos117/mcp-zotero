import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse, formatEmptyResult } from "../utils/error-formatter.js";
import { formatCreators, formatTags } from "../utils/item-formatter.js";
import { fetchAllPages } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { COLLECTION_KEY_HINT } from "../utils/error-hints.js";

export const toolConfig = {
  name: "get_collection_items",
  description: "Get all items in a specific Zotero collection (only items directly in it, not those in its subcollections). Returns item keys, titles, authors, and dates. Use the collectionKey from get_collections. Use the returned item keys with get_items_details, get_item_fulltext, or inject_citations.",
  inputSchema: {
    collectionKey: zoteroKey().describe("Collection key from get_collections"),
    excludeAttachments: z
      .boolean()
      .default(true)
      .describe(
        "Exclude attachment and note items (default: true). Set false to list them too."
      ),
    ...libraryArgsSchema,
  },
} as const;

const CollectionItemsSchema = z.object(toolConfig.inputSchema);

export async function handleGetCollectionItems(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { collectionKey, excludeAttachments, library_type, library_id } = CollectionItemsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  try {
    const { items: allItems, totalResults } = await fetchAllPages((params) =>
      zoteroApi.library(libraryType, libraryId).collections(collectionKey).items().get(params)
    );

    if (!allItems || allItems.length === 0) {
      return formatEmptyResult("Collection is empty", {
        collectionKey,
        suggestion:
          "No items directly in this collection. Items of its subcollections are not listed: find them with get_collections (parentCollection = this key). To add items, pass collection_key to add_items_by_doi or add_items.",
        status: "empty",
      });
    }

    let items = allItems;
    if (excludeAttachments) {
      items = items.filter(
        (item: ZoteroItemData) =>
          item.itemType !== "attachment" && item.itemType !== "note"
      );
    }

    const formatted = items
      .filter((item) => item)
      .map((item: ZoteroItemData) => ({
        title: item.title || "Untitled",
        authors: formatCreators(item.creators),
        date: item.date || "No date",
        key: item.key || "No key",
        itemType: item.itemType || "Unknown type",
        tags: formatTags(item.tags),
        doi: item.DOI || null,
        url: item.url || null,
        publicationTitle: item.publicationTitle || null,
      }));

    if (formatted.length === 0) {
      return formatEmptyResult(
        "No valid items found in collection",
        {
          collectionKey,
          suggestion:
            "The collection contains only attachments or notes, which excludeAttachments=true (the default) hides: call again with excludeAttachments=false to list them.",
          status: "invalid_items",
        }
      );
    }

    return formatJsonResult({
      total_items: totalResults,
      returned_items: formatted.length,
      items: formatted,
    });
  } catch (err) {
    if (isZoteroApiError(err)) {
      if (err.response?.status === 404) {
        return formatErrorResponse(
          "Collection not found: no collection with this key in this library, or the API key cannot access it.",
          {
            collectionKey,
            suggestion: COLLECTION_KEY_HINT,
            status: "not_found",
          }
        );
      }
    }
    throw err;
  }
}
