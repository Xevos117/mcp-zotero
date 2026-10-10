import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { UnsafeOperationsMode, canDeleteItems } from "../utils/unsafe-operations.js";
import { fetchItemsByKeys } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "delete_items",
  description:
    "Delete one or more items from your Zotero library: they are permanently deleted (not moved to the Zotero trash). Accepts up to 50 item keys per call. Requires UNSAFE_OPERATIONS environment variable set to 'items' or 'all'.",
  inputSchema: {
    item_keys: z
      .array(z.string())
      .min(1)
      .max(50)
      .describe(
        'Array of Zotero item keys to delete (e.g. ["EUHUT5K3", "F9UQM7N2"]). Max 50 per call.'
      ),
    ...libraryArgsSchema,
  },
} as const;

const DeleteItemsSchema = z.object(toolConfig.inputSchema);

export async function handleDeleteItems(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>,
  unsafeOps: UnsafeOperationsMode = "none"
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_keys, library_type, library_id } = DeleteItemsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  if (!canDeleteItems(unsafeOps)) {
    return formatErrorResponse(
      "Deletion of items is not allowed. Set the UNSAFE_OPERATIONS environment variable to 'items' or 'all' to enable this operation.",
      {
        env_var: "UNSAFE_OPERATIONS",
        current_value: unsafeOps,
        required_values: ["items", "all"],
      }
    );
  }

  try {
    const { items, version: libraryVersion } = await fetchItemsByKeys(
      (params) => zoteroApi.library(libraryType, libraryId).items().get(params),
      item_keys
    );

    const foundKeys = new Set(items.map((item) => item.key).filter(Boolean));
    const notFoundKeys = item_keys.filter((k) => !foundKeys.has(k));

    if (foundKeys.size === 0) {
      return formatErrorResponse("No items found for the given keys", {
        item_keys,
        status: "not_found",
      });
    }

    // Use library version from response header (Last-Modified-Version),
    // not individual item versions — required for multi-object DELETE
    if (libraryVersion === null) {
      return formatErrorResponse("Could not determine library version", {
        item_keys,
      });
    }

    const keysToDelete = [...foundKeys] as string[];

    await zoteroApi
      .library(libraryType, libraryId)
      .items()
      .version(libraryVersion)
      .delete(keysToDelete);

    const result: Record<string, unknown> = {
      deleted_keys: keysToDelete,
      deleted_count: keysToDelete.length,
    };

    if (notFoundKeys.length > 0) {
      result.not_found = notFoundKeys;
    }

    return formatJsonResult(result);
  } catch (err) {
    if (isZoteroApiError(err)) {
      if (err.response.status === 412) {
        return formatErrorResponse(
          "Items were modified by another client. Retry the operation.",
          {
            item_keys,
            status: "version_conflict",
          }
        );
      }
    }
    throw err;
  }
}
