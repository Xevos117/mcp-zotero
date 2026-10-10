import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { UnsafeOperationsMode, canDeleteCollections } from "../utils/unsafe-operations.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "delete_collection",
  description:
    "Delete a collection (folder) from your Zotero library. Items inside the collection are NOT deleted — they remain in your library. Requires UNSAFE_OPERATIONS environment variable set to 'all'.",
  inputSchema: {
    collection_key: z
      .string()
      .min(1)
      .describe("Zotero collection key to delete. Get this from get_collections."),
    ...libraryArgsSchema,
  },
} as const;

const DeleteCollectionSchema = z.object(toolConfig.inputSchema);

export async function handleDeleteCollection(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>,
  unsafeOps: UnsafeOperationsMode = "none"
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { collection_key, library_type, library_id } = DeleteCollectionSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  if (!canDeleteCollections(unsafeOps)) {
    return formatErrorResponse(
      "Deletion of collections is not allowed. Set the UNSAFE_OPERATIONS environment variable to 'all' to enable this operation.",
      {
        env_var: "UNSAFE_OPERATIONS",
        current_value: unsafeOps,
        required_values: ["all"],
      }
    );
  }

  try {
    const response = await zoteroApi
      .library(libraryType, libraryId)
      .collections(collection_key)
      .get();

    const collection = response.getData() as ZoteroItemData;
    const version = response.getVersion();

    if (version === null) {
      return formatErrorResponse("Could not determine collection version", {
        collection_key,
      });
    }

    await zoteroApi
      .library(libraryType, libraryId)
      .collections(collection_key)
      .version(version)
      .delete();

    return formatJsonResult({
      deleted: true,
      collection_key,
      name: collection.name || collection_key,
    });
  } catch (err) {
    if (isZoteroApiError(err)) {
      if (err.response.status === 404) {
        return formatErrorResponse("Collection not found", {
          collection_key,
          status: "not_found",
        });
      }
      if (err.response.status === 412) {
        return formatErrorResponse(
          "Collection was modified by another client. Retry the operation.",
          {
            collection_key,
            status: "version_conflict",
          }
        );
      }
    }
    throw err;
  }
}
