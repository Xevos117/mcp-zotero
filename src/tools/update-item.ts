import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import {
  ZoteroApiInterface,
  ZoteroItemData,
  isZoteroApiError,
} from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import {
  CreatorSchema,
  fieldValidationIssues,
  creatorValidationIssues,
  toZoteroCreator,
} from "../utils/item-fields.js";
import { TITLE_FIELD_NAME, ZoteroItemType } from "../utils/zotero-item-types.js";
import { ITEM_KEY_HINT } from "../utils/error-hints.js";

/**
 * Fields a user must not set through update_item: identity, server-managed metadata, and structural
 * relations that have their own dedicated tools (collections, parent, relations). itemType cannot change.
 */
const PROTECTED_FIELDS = new Set([
  "key",
  "version",
  "itemType",
  "parentItem",
  "collections",
  "relations",
  "dateAdded",
  "dateModified",
]);

const VERSION_CONFLICT_HINT =
  "Re-read the item with get_items_details to get its current version, then call update_item again with that version.";

export const toolConfig = {
  name: "update_item",
  description:
    "Update the metadata of an existing Zotero item: change field values and/or replace its creators. Pass the item's current `version` (from get_items_details) — the update is rejected as a version_conflict if the item changed since you read it, so re-read and retry in that case. `fields` are Zotero field names valid for the item's type (e.g. title, date, publicationTitle, volume, pages, DOI, url, publisher). itemType cannot be changed, and key/version/collections/parentItem/relations/dateAdded/dateModified are managed by Zotero and rejected. Use add_items for new items, create_note for notes, and delete_items to remove items.",
  inputSchema: {
    item_key: zoteroKey().describe(
      "Key of the item to update (from search_library, get_items_details or get_collection_items)."
    ),
    version: z
      .number()
      .int()
      .describe(
        "The item's current version, as returned by get_items_details. Guards against overwriting a concurrent change."
      ),
    fields: z
      .record(z.string(), z.string())
      .describe(
        'Field values to set, as { fieldName: value }. Use Zotero field names valid for the item type (e.g. { "title": "New title", "date": "2024" }). Pass {} if you only want to change creators.'
      ),
    creators: z
      .array(CreatorSchema)
      .optional()
      .describe(
        "Replaces the item's entire creators list when provided. Each creator is {firstName, lastName, creatorType} or {name, creatorType} for institutional authors."
      ),
    ...libraryArgsSchema,
  },
} as const;

const UpdateItemSchema = z.object(toolConfig.inputSchema);

export async function handleUpdateItem(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_key, version, fields, creators, library_type, library_id } = UpdateItemSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const protectedUsed = Object.keys(fields).filter((k) => PROTECTED_FIELDS.has(k));
  if (protectedUsed.length > 0) {
    return formatErrorResponse(
      `These fields cannot be set with update_item: ${protectedUsed.join(", ")}`,
      {
        hint: "itemType is fixed; key/version/collections/parentItem/relations/dateAdded/dateModified are managed by Zotero. Remove them and keep only editable metadata fields.",
      }
    );
  }

  if (Object.keys(fields).length === 0 && creators === undefined) {
    return formatErrorResponse("Nothing to update: provide at least one field or creators.");
  }

  // Fetch the item for its type and current version.
  let item: ZoteroItemData;
  try {
    const resp = await zoteroApi.library(libraryType, libraryId).items(item_key).get();
    item = resp.getData() as ZoteroItemData;
  } catch (err) {
    if (isZoteroApiError(err) && err.response.status === 404) {
      return formatErrorResponse(`Item ${item_key} not found`, { hint: ITEM_KEY_HINT });
    }
    throw err;
  }

  const itemType = item.itemType as ZoteroItemType;

  // Version mismatch: do not patch, tell the model to re-read.
  if (item.version !== version) {
    return formatErrorResponse("Version conflict: the item changed since you read it", {
      code: "version_conflict",
      item_key,
      expected_version: version,
      ...(typeof item.version === "number" ? { current_version: item.version } : {}),
      hint: VERSION_CONFLICT_HINT,
    });
  }

  // `title` is universal in our tools; map it to the type-specific field name where one exists.
  const titleFieldName = TITLE_FIELD_NAME[itemType];
  const patchFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    patchFields[k === "title" && titleFieldName ? titleFieldName : k] = v;
  }

  const fieldIssues = fieldValidationIssues(itemType, Object.keys(patchFields));
  const creatorIssues = creators ? creatorValidationIssues(itemType, creators) : [];
  if (fieldIssues.length > 0 || creatorIssues.length > 0) {
    return formatErrorResponse(`Invalid fields for itemType "${itemType}"`, {
      problems: [...fieldIssues, ...creatorIssues].map((i) => i.message),
      hint: "Use field names and creator types valid for this item's type (see the message for the valid options).",
    });
  }

  const patchBody: Record<string, unknown> = { ...patchFields };
  if (creators) {
    patchBody.creators = creators.map(toZoteroCreator);
  }

  try {
    const resp = await zoteroApi
      .library(libraryType, libraryId)
      .items(item_key)
      .version(version)
      .patch(patchBody);
    return formatJsonResult({
      item_key,
      version: resp.getVersion(),
      updated_fields: Object.keys(patchFields),
      ...(creators ? { creators_replaced: true } : {}),
    });
  } catch (err) {
    if (isZoteroApiError(err) && err.response.status === 412) {
      const current = (err.response as { headers?: Headers }).headers?.get?.("last-modified-version");
      return formatErrorResponse("Version conflict: the item changed since you read it", {
        code: "version_conflict",
        item_key,
        expected_version: version,
        ...(current ? { current_version: Number(current) } : {}),
        hint: VERSION_CONFLICT_HINT,
      });
    }
    throw err;
  }
}
