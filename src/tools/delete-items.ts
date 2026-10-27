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
    "Delete one or more items from your Zotero library. By default they are moved to the Zotero trash (recoverable by the user from Zotero → Trash); pass permanent: true to delete them for good (not recoverable), which is the old behaviour — confirm with the user first for a permanent delete. Moving an item to the trash does not move its child notes or attachments to the trash (they stay in the library), matching the Zotero app; a permanent delete also removes an item's children. A key already in the trash is reported in already_in_trash (use permanent: true to erase it). Accepts up to 50 item keys per call. Disabled unless the server setting UNSAFE_OPERATIONS is 'items' or 'all' (the same setting gates both trash and permanent deletion).",
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
        // Always include trashed items: a permanent delete must reach items already in the trash, and a
        // default (trash) delete must recognise an item that is already there — reported as
        // already_in_trash rather than written again.
        (params) => zoteroApi.library(libraryType, libraryId).items().get({ ...params, includeTrashed: 1 }),
        pending
      );

      const byKey = new Map<string, Record<string, unknown>>();
      for (const item of items) if (typeof item.key === "string") byKey.set(item.key, item as Record<string, unknown>);
      notFoundKeys.push(...pending.filter((k) => !byKey.has(k)));

      if (byKey.size === 0) {
        return formatErrorResponse("No items found for the given keys", {
          item_keys,
          status: "not_found",
          hint: `Nothing was deleted: none of these keys exists in this library (in another library, or permanently deleted). ${ITEM_KEY_HINT}`,
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

      // only keys the caller asked for that exist (whatever extra the API returned)
      const foundKeys = pending.filter((k) => byKey.has(k));
      const isTrashed = (k: string) => {
        const d = byKey.get(k)?.deleted;
        return d === 1 || d === true;
      };

      if (permanent) {
        // DELETE reaches live and already-trashed items alike; Zotero erases child notes/attachments
        // server-side (so a permanent delete of a parent removes its children too).
        try {
          await zoteroApi.library(libraryType, libraryId).items().version(libraryVersion).delete(foundKeys);
        } catch (err) {
          if (attempt === 1 && isZoteroApiError(err) && err.response.status === 412) {
            pending = foundKeys;
            continue;
          }
          throw err;
        }
        const result: Record<string, unknown> = { deleted_keys: foundKeys, deleted_count: foundKeys.length, mode: "permanent" };
        if (notFoundKeys.length > 0) result.not_found = notFoundKeys;
        return formatJsonResult(result);
      }

      // Default: move the live items to the Zotero trash by setting deleted:1 in a multi-object write (POST
      // has PATCH semantics, so only `deleted` changes); the library version from the GET header
      // (If-Unmodified-Since-Version) guards against a concurrent change, exactly like the DELETE path.
      // Trashing a parent does NOT move its child notes/attachments to the trash — that matches the Zotero
      // client (Zotero.Items.trash marks only the selected items), unlike permanent deletion. An item
      // already in the trash is left as it is and reported in already_in_trash.
      const alreadyInTrash = foundKeys.filter(isTrashed);
      const toTrash = foundKeys.filter((k) => !isTrashed(k));

      let trashErrors: Record<string, ZoteroWriteError> | null = null;
      if (toTrash.length > 0) {
        try {
          const payload = toTrash.map((key) => ({ key, version: libraryVersion, deleted: 1 }));
          const response: ZoteroWriteResponse = await zoteroApi
            .library(libraryType, libraryId)
            .items()
            .version(libraryVersion)
            .post(payload);
          const errors = response.getErrors();
          if (Object.keys(errors).length > 0) trashErrors = errors;
        } catch (err) {
          if (attempt === 1 && isZoteroApiError(err) && err.response.status === 412) {
            pending = toTrash;
            continue;
          }
          throw err;
        }
      }

      // Per-object outcome of the trash write: an index in getErrors() failed (a partial failure is
      // possible — the server writes each object independently), the rest were moved to the trash.
      const failedIndexes = trashErrors ? Object.keys(trashErrors).map(Number) : [];
      const trashed = toTrash.filter((_, i) => !failedIndexes.includes(i));
      if (toTrash.length > 0 && trashed.length === 0 && alreadyInTrash.length === 0) {
        return formatErrorResponse(`Could not move items to the trash: ${formatWriteErrors(trashErrors ?? {})}. Nothing was deleted.`, {
          item_keys,
          hint: "Retry the same call once.",
        });
      }

      const result: Record<string, unknown> = {
        deleted_keys: trashed,
        deleted_count: trashed.length,
        mode: "trash",
      };
      if (notFoundKeys.length > 0) result.not_found = notFoundKeys;
      const failedKeys = failedIndexes.map((i) => toTrash[i]);
      if (failedKeys.length > 0) result.failed = failedKeys;
      if (alreadyInTrash.length > 0) {
        result.already_in_trash = alreadyInTrash;
        result.hint =
          "These keys were already in the Zotero trash and were left as they are; call again with permanent: true to delete them for good.";
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
