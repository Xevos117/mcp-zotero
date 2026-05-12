import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { formatCreators } from "../utils/item-formatter.js";
import { logger } from "../utils/logger.js";
import { getLibraryType } from "../utils/library-context.js";

export const toolConfig = {
  name: "get_items_details",
  description:
    "Get metadata for multiple Zotero items in a single call. Accepts an array of item keys and returns a map of key → metadata. Use this instead of calling get_item_details multiple times. Returns all type-specific fields (e.g. bookTitle for bookSection, proceedingsTitle for conferencePaper, university for thesis). Set include_abstract to include abstracts (excluded by default to keep responses lightweight).",
  inputSchema: {
    item_keys: z
      .array(z.string())
      .describe(
        'Array of Zotero item keys (e.g. ["EUHUT5K3", "F9UQM7N2"]). Get these from search_library, add_items_by_doi, or get_collection_items.'
      ),
    include_abstract: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Include abstractNote in the response. Default false to keep responses lightweight."
      ),
  },
} as const;

const GetItemsDetailsSchema = z.object(toolConfig.inputSchema);

/** Fields excluded from the response (structural/internal, not bibliographic metadata). */
const SKIP_FIELDS = new Set([
  "key", "version", "dateAdded", "dateModified",
  "collections", "tags", "relations", "creators",
  "abstractNote",
]);

export async function handleGetItemsDetails(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_keys, include_abstract } = GetItemsDetailsSchema.parse(args);

  if (item_keys.length === 0) {
    return formatErrorResponse("At least one item key is required");
  }

  try {
    const response = await zoteroApi
      .library(getLibraryType(), userId)
      .items()
      .get({ itemKey: item_keys.join(",") });

    const items = response.getData() as ZoteroItemData[];

    if (!items || (Array.isArray(items) && items.length === 0)) {
      return formatErrorResponse("No items found for the given keys", {
        item_keys,
      });
    }

    const itemList = Array.isArray(items) ? items : [items];

    const result: Record<string, Record<string, unknown>> = {};
    for (const item of itemList) {
      const key = item.key;
      if (!key) continue;

      const entry: Record<string, unknown> = {
        itemType: item.itemType || "document",
        title: item.title || "Untitled",
        authors: formatCreators(item.creators),
      };

      // Include all non-empty bibliographic fields from the Zotero response
      const raw = item as Record<string, unknown>;
      for (const [field, value] of Object.entries(raw)) {
        if (SKIP_FIELDS.has(field)) continue;
        if (field in entry) continue;
        if (value === undefined || value === null || value === "" || value === false) continue;
        entry[field] = value;
      }

      if (include_abstract && item.abstractNote) {
        entry.abstractNote = item.abstractNote;
      }

      result[key] = entry;
    }

    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  } catch (err) {
    if (isZoteroApiError(err)) {
      logger.error("Tool execution failed", {
        tool: "get_items_details",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}
