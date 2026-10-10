import { z } from "zod";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { formatWriteErrors } from "../utils/write-results.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "create_collection",
  description:
    "Create a new collection (folder) in your Zotero library. Optionally nest it under a parent collection. Returns the new collection key and name. Use the key with add_items_by_doi to organize imported papers.",
  inputSchema: {
    name: z.string().describe("Name of the new collection"),
    parent_collection: z
      .string()
      .optional()
      .describe(
        "Zotero collection key of the parent collection. Get this from get_collections."
      ),
    ...libraryArgsSchema,
  },
} as const;

const CreateCollectionSchema = z.object(toolConfig.inputSchema);

export async function handleCreateCollection(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { name, parent_collection, library_type, library_id } = CreateCollectionSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  if (!name?.trim()) {
    return formatErrorResponse("Collection name is required");
  }

  const collectionData: Record<string, unknown> = { name: name.trim() };
  if (parent_collection) {
    collectionData.parentCollection = parent_collection;
  }

  const response = await zoteroApi
    .library(libraryType, libraryId)
    .collections()
    .post([collectionData]);

  if (!response.isSuccess()) {
    const errorMsg = formatWriteErrors(response.getErrors());
    return formatErrorResponse("Failed to create collection", {
      details: errorMsg,
    });
  }

  const created = response.getData();
  const collection = created[0];

  return formatJsonResult({
    collection_key: collection.key,
    name: collection.name,
  });
}
