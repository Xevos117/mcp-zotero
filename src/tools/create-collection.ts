import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { formatWriteErrors } from "../utils/write-results.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { COLLECTION_KEY_HINT } from "../utils/error-hints.js";

export const toolConfig = {
  name: "create_collection",
  description:
    "Create a new collection (folder) in your Zotero library. Optionally nest it under a parent collection. Returns the new collection key and name. Use the key as collection_key in add_items_by_doi or add_items to organize imported papers.",
  inputSchema: {
    name: z.string().describe("Name of the new collection"),
    parent_collection: zoteroKey()
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
    return formatErrorResponse("Collection name is required: pass a non-empty name.");
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
      hint: parent_collection
        ? `details has Zotero's reason. Check that parent_collection exists: ${COLLECTION_KEY_HINT}`
        : "details has Zotero's reason: fix the name if it is the cause and retry.",
    });
  }

  const created = response.getData();
  const collection = created[0];

  return formatJsonResult({
    collection_key: collection.key,
    name: collection.name,
  });
}
