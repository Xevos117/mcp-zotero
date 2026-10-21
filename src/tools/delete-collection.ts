import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { UnsafeOperationsMode, canDeleteCollections } from "../utils/unsafe-operations.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { COLLECTION_KEY_HINT, unsafeOperationsHint } from "../utils/error-hints.js";

export const toolConfig = {
  name: "delete_collection",
  description:
    "Delete a collection (folder) from your Zotero library; confirm with the user first. Items inside the collection are NOT deleted — they remain in your library. Disabled unless the server setting UNSAFE_OPERATIONS is 'all'.",
  inputSchema: {
    collection_key: zoteroKey()
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
      `Deletion of collections is not allowed: it needs UNSAFE_OPERATIONS 'all' in this server's configuration (it is '${unsafeOps}'). Nothing was deleted.`,
      {
        hint: unsafeOperationsHint("collections"),
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
        hint: "Nothing was deleted. Retry the same call once.",
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
          hint: `Nothing was deleted. ${COLLECTION_KEY_HINT}`,
        });
      }
      if (err.response.status === 412) {
        return formatErrorResponse(
          "Collection was modified by another client, so it was not deleted. Retry the same call.",
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
