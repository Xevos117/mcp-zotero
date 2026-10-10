import { z } from "zod";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatEmptyResult } from "../utils/error-formatter.js";
import { fetchAllPages } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "get_collections",
  description: "List all collections (folders) in your Zotero library. Returns collection keys, names, and parent relationships. Use collection keys with get_collection_items or as parent_collection in create_collection. Trashed collections are excluded by default.",
  inputSchema: {
    include_trashed: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include trashed (deleted) collections. Default false."),
    ...libraryArgsSchema,
  },
} as const;

const GetCollectionsSchema = z.object(toolConfig.inputSchema);

export async function handleGetCollections(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { include_trashed, library_type, library_id } = GetCollectionsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const { items: allCollections } = await fetchAllPages((params) =>
    zoteroApi.library(libraryType, libraryId).collections().get(params)
  );

  if (!Array.isArray(allCollections) || allCollections.length === 0) {
    return formatEmptyResult("No collections found", {
      suggestion:
        "Create a collection in your Zotero library first",
      helpUrl: "https://www.zotero.org/support/collections",
    });
  }

  // Zotero API returns deleted collections despite not requesting them —
  // filter client-side as a workaround
  const collections = include_trashed
    ? allCollections
    : allCollections.filter((c) => !(c as Record<string, unknown>).deleted);

  if (collections.length === 0) {
    return formatEmptyResult("No collections found", {
      suggestion:
        "All collections are in the trash. Use include_trashed=true to see them.",
    });
  }

  return formatJsonResult(collections);
}
