import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroWriteResponse, ZoteroWriteError, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { formatWriteErrors } from "../utils/write-results.js";
import { UnsafeOperationsMode, canDeleteItems } from "../utils/unsafe-operations.js";
import { fetchItemsByKeys } from "../utils/pagination.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { ITEM_KEY_HINT, unsafeOperationsHint, zoteroStatusHint } from "../utils/error-hints.js";

export const toolConfig = {
  name: "delete_items",
  description:
    "Delete one or more items from your Zotero library. By default they are moved to the Zotero trash (recoverable by the user from Zotero → Trash); pass permanent: true to delete them for good (not recoverable), which is the old behaviour — confirm with the user first for a permanent delete. Accepts up to 50 item keys per call. Disabled unless the server setting UNSAFE_OPERATIONS is 'items' or 'all' (the same setting gates both trash and permanent deletion).",
  inputSchema: {
    item_keys: z
      .array(zoteroKey())
      .min(1)
      .max(50)
      .describe(
        'Array of Zotero item keys to delete (e.g. ["EUHUT5K3", "F9UQM7N2"]). Max 50 per call.'
      ),
    permanent: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "false (default): move the items to the Zotero trash, where the user can restore them. true: delete them permanently (not recoverable)."
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
  const { item_keys, permanent, library_type, library_id } = DeleteItemsSchema.parse(args);
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
        // A permanent delete must also reach items already in the trash (e.g. previously moved there by a
        // default delete_items), which the Web API omits from listings unless includeTrashed is set.
        (params) =>
          zoteroApi
            .library(libraryType, libraryId)
            .items()
            .get(permanent ? { ...params, includeTrashed: 1 } : params),
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

      // Default: move to the Zotero trash by setting deleted:1 in a multi-object write (POST has PATCH
      // semantics, so only `deleted` changes). permanent: true keeps the old behaviour (DELETE). Both the
      // library version from the GET header (If-Unmodified-Since-Version) and a per-object `version` guard
      // the write against a concurrent change, exactly like the DELETE path.
      let trashErrors: Record<string, ZoteroWriteError> | null = null;
      try {
        if (permanent) {
          await zoteroApi.library(libraryType, libraryId).items().version(libraryVersion).delete(keysToDelete);
        } else {
          const payload = keysToDelete.map((key) => ({ key, version: libraryVersion, deleted: 1 }));
          const response: ZoteroWriteResponse = await zoteroApi
            .library(libraryType, libraryId)
            .items()
            .version(libraryVersion)
            .post(payload);
          const errors = response.getErrors();
          if (Object.keys(errors).length > 0) trashErrors = errors;
        }
      } catch (err) {
        // 412: the library changed between the GET and the write (another client, a sync). Read the new
        // version and the keys that still exist, and retry once with those.
        if (attempt === 1 && isZoteroApiError(err) && err.response.status === 412) {
          pending = keysToDelete;
          continue;
        }
        throw err;
      }

      // A per-object failure in the trash write (none succeeded) is reported; a partial failure cannot happen
      // with a single library version, but is surfaced if it ever does.
      const failedIndexes = trashErrors ? Object.keys(trashErrors).map(Number) : [];
      const trashed = keysToDelete.filter((_, i) => !failedIndexes.includes(i));
      if (!permanent && trashed.length === 0) {
        return formatErrorResponse(`Could not move items to the trash: ${formatWriteErrors(trashErrors ?? {})}. Nothing was deleted.`, {
          item_keys,
          hint: "Retry the same call once.",
        });
      }
      const deletedKeys = permanent ? keysToDelete : trashed;

      const result: Record<string, unknown> = {
        deleted_keys: deletedKeys,
        deleted_count: deletedKeys.length,
        mode: permanent ? "permanent" : "trash",
      };

      if (notFoundKeys.length > 0) {
        result.not_found = notFoundKeys;
      }
      const failedKeys = failedIndexes.map((i) => keysToDelete[i]);
      if (failedKeys.length > 0) {
        result.failed = failedKeys;
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
