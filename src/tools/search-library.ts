import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData } from "../types/zotero-types.js";
import { formatJsonResult, formatEmptyResult } from "../utils/error-formatter.js";
import { formatCreators } from "../utils/item-formatter.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "search_library",
  description: `Search your Zotero library or list items sorted by a field.

When 'query' is provided, matches it against titles, creator names and years (not abstracts, tags or full text).
When 'query' is omitted, lists items sorted by the chosen field (default: dateAdded, descending).

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
      .int()
      .min(1)
      .optional()
      .default(25)
      .describe("Maximum number of items to return, 1-100 (default: 25; above 100 returns 100)"),
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

  const response = await zoteroApi
    .library(libraryType, libraryId)
    .items()
    .get(params);

  const items = response.getData();

  if (!Array.isArray(items) || items.length === 0) {
    if (query) {
      return formatEmptyResult("No results found", {
        query,
        suggestion:
          "Nothing in this library matches the query in title, creator or year. Try fewer or different words (one author surname or a title keyword), or omit query to list recent items. For a group library pass library_type and library_id.",
      });
    }
    return formatEmptyResult("No items found", {
      suggestion: "This library has no items yet. Add some with add_items_by_doi (items with a DOI) or add_items.",
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

  return formatJsonResult(formatted);
}
