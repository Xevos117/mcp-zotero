import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { formatCreators } from "../utils/item-formatter.js";
import { logger } from "../utils/logger.js";
import { getLibraryType, resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "search_library",
  description: `Search your Zotero library or list items sorted by a field.

When 'query' is provided, searches by title, author, or any field.
When 'query' is omitted, lists items sorted by the chosen field (default: dateAdded, descending) — this replaces the old get_recent tool.

Examples:
  - Search: { "query": "deep learning" }
  - Recent items: { "sort": "dateAdded", "limit": 10 }
  - Recent with search: { "query": "transformers", "sort": "dateAdded", "limit": 5 }

Use the returned item keys with get_items_details, get_item_fulltext, or inject_citations.`,
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe("Search query. If omitted, returns items sorted by the chosen field."),
    sort: z
      .enum(["dateAdded", "dateModified", "title", "creator", "date"])
      .optional()
      .default("dateAdded")
      .describe("Field to sort by (default: dateAdded)"),
    direction: z
      .enum(["asc", "desc"])
      .optional()
      .default("desc")
      .describe("Sort direction (default: desc)"),
    limit: z
      .number()
      .optional()
      .default(25)
      .describe("Maximum number of items to return (default: 25, max: 100)"),
    ...libraryArgsSchema,
  },
} as const;

const SearchSchema = z.object(toolConfig.inputSchema);

export async function handleSearchLibrary(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { query, sort, direction, limit, library_type, library_id } = SearchSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const params: Record<string, string | number> = {
    sort,
    direction,
    limit: Math.min(limit, 100),
  };

  if (query?.trim()) {
    params.q = query.trim();
  }

  try {
    const response = await zoteroApi
      .library(libraryType, libraryId)
      .items()
      .get(params);

    const items = response.getData();

    if (!Array.isArray(items) || items.length === 0) {
      if (query) {
        return formatErrorResponse("No results found", {
          query,
          suggestion:
            "Try a different search term or verify your library contains matching items",
        });
      }
      return formatErrorResponse("No items found", {
        suggestion: "Add some items to your Zotero library first",
      });
    }

    const formatted = items.map((item: ZoteroItemData) => ({
      title: item.title || "Untitled",
      authors: formatCreators(item.creators),
      date: item.date || "No date",
      key: item.key,
      itemType: item.itemType,
      ...(sort === "dateAdded" && { dateAdded: item.dateAdded || null }),
    }));

    return {
      content: [
        { type: "text", text: JSON.stringify(formatted, null, 2) },
      ],
    };
  } catch (err) {
    if (isZoteroApiError(err)) {
      logger.error("Tool execution failed", {
        tool: "search_library",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}
