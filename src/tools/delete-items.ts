import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { UnsafeOperationsMode, canDeleteItems } from "../utils/unsafe-operations.js";
import { fetchItemsByKeys } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { ITEM_KEY_HINT, unsafeOperationsHint, zoteroStatusHint } from "../utils/error-hints.js";

export const toolConfig = {
  name: "delete_items",
  description:
    "Delete one or more items from your Zotero library: they are permanently deleted (not moved to the Zotero trash), so confirm with the user first. Accepts up to 50 item keys per call. Disabled unless the server setting UNSAFE_OPERATIONS is 'items' or 'all'.",
  inputSchema: {
    item_keys: z
      .array(zoteroKey())
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
      `Deletion of items is not allowed: destructive operations are disabled in this server's configuration (UNSAFE_OPERATIONS is '${unsafeOps}'). Nothing was deleted.`,
      {
        env_var: "UNSAFE_OPERATIONS",
        current_value: unsafeOps,
        required_values: ["items", "all"],
        hint: unsafeOperationsHint("items"),
      }
    );
  }

  try {
    const notFoundKeys: string[] = [];
    let pending = item_keys;
    for (let attempt = 1; ; attempt++) {
      const { items, version: libraryVersion } = await fetchItemsByKeys(
        (params) => zoteroApi.library(libraryType, libraryId).items().get(params),
        pending
      );

      const foundKeys = new Set(items.map((item) => item.key).filter(Boolean));
      notFoundKeys.push(...pending.filter((k) => !foundKeys.has(k)));

      if (foundKeys.size === 0) {
        return formatErrorResponse("No items found for the given keys", {
          item_keys,
          status: "not_found",
          hint: `Nothing was deleted: none of these keys exists in this library (already deleted, or in another library). ${ITEM_KEY_HINT}`,
        });
      }

      // Use library version from response header (Last-Modified-Version),
      // not individual item versions — required for multi-object DELETE
      if (libraryVersion === null) {
        return formatErrorResponse("Could not determine library version", {
          item_keys,
          hint: "Nothing was deleted. Retry the same call once.",
        });
      }

      // only keys the caller asked for, whatever the API returned
      const keysToDelete = pending.filter((k) => foundKeys.has(k));

      try {
        await zoteroApi
          .library(libraryType, libraryId)
          .items()
          .version(libraryVersion)
          .delete(keysToDelete);
      } catch (err) {
        // 412: the library changed between the GET and the DELETE (another client, a sync). Read the new
        // version and the keys that still exist, and retry once with those.
        if (attempt === 1 && isZoteroApiError(err) && err.response.status === 412) {
          pending = keysToDelete;
          continue;
        }
        throw err;
      }

      const result: Record<string, unknown> = {
        deleted_keys: keysToDelete,
        deleted_count: keysToDelete.length,
      };

      if (notFoundKeys.length > 0) {
        result.not_found = notFoundKeys;
      }

      return formatJsonResult(result);
    }
  } catch (err) {
    if (isZoteroApiError(err) && err.response.status === 412) {
      const { hint } = zoteroStatusHint(412);
      return formatErrorResponse(
        "Items were modified by another client (HTTP 412 Precondition Failed), also on a second try with the new library version, so nothing was deleted.",
        {
          item_keys,
          status: "version_conflict",
          http_status: 412,
          hint,
        }
      );
    }
    throw err;
  }
}
