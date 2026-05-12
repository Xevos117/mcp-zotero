import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { UnsafeOperationsMode, canDeleteItems } from "../utils/unsafe-operations.js";
import { logger } from "../utils/logger.js";
import { getLibraryType, resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "delete_items",
  description:
    "Delete one or more items from your Zotero library permanently (moves to trash). Accepts up to 50 item keys per call. Requires UNSAFE_OPERATIONS environment variable set to 'items' or 'all'.",
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
    const response = await zoteroApi
      .library(libraryType, libraryId)
      .items()
      .get({ itemKey: item_keys.join(",") });

    const items = response.getData() as ZoteroItemData[];
    const itemList = Array.isArray(items) ? items : [items];

    const foundKeys = new Set(itemList.map((item) => item.key).filter(Boolean));
    const notFoundKeys = item_keys.filter((k) => !foundKeys.has(k));

    if (foundKeys.size === 0) {
      return formatErrorResponse("No items found for the given keys", {
        item_keys,
        status: "not_found",
      });
    }

    // Use library version from response header (Last-Modified-Version),
    // not individual item versions — required for multi-object DELETE
    const libraryVersion = response.getVersion();
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
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
      logger.error("Tool execution failed", {
        tool: "delete_items",
        status: err.response.status,
        errorMessage: err.message,
        url: err.response.url,
      });
    }
    throw err;
  }
}
