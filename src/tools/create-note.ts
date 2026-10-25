import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import {
  ZoteroApiInterface,
  ZoteroItemData,
  isZoteroApiError,
} from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { formatWriteErrors } from "../utils/write-results.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { escapeXml } from "../citation-injector/xml-utils.js";
import { ITEM_KEY_HINT } from "../utils/error-hints.js";

export const toolConfig = {
  name: "create_note",
  description:
    "Add a child note to an existing Zotero item. Provide the note as PLAIN TEXT (no HTML or Markdown): blank lines become separate paragraphs and single line breaks are preserved. The parent must be a regular item (not a note or attachment). Use this to attach a summary, annotation, or reading note to a reference. For top-level, item-wide editing of fields use update_item; to add references use add_items or add_items_by_doi.",
  inputSchema: {
    parent_item_key: zoteroKey().describe(
      "Key of the regular item the note is attached to (from search_library, get_items_details, get_collection_items or an add_* tool). It must not be a note or an attachment."
    ),
    note: z
      .string()
      .min(1)
      .describe(
        "The note text, PLAIN TEXT only (no HTML/Markdown). Blank lines separate paragraphs; single newlines are kept as line breaks."
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to the note"),
    ...libraryArgsSchema,
  },
} as const;

const CreateNoteSchema = z.object(toolConfig.inputSchema);

/**
 * Plain text → the minimal HTML Zotero stores in a note: one <p> per paragraph (blocks separated by a
 * blank line), single newlines as <br/>. Everything is XML-escaped first, so user text can never inject markup.
 */
export function noteTextToHtml(text: string): string {
  return text
    .split(/\n[ \t]*\n/)
    .map((para) => `<p>${escapeXml(para).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export async function handleCreateNote(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { parent_item_key, note, tags, library_type, library_id } = CreateNoteSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  // Fetch the parent first: a note can only hang off a regular item.
  let parent: ZoteroItemData;
  try {
    const resp = await zoteroApi.library(libraryType, libraryId).items(parent_item_key).get();
    parent = resp.getData() as ZoteroItemData;
  } catch (err) {
    if (isZoteroApiError(err) && err.response.status === 404) {
      return formatErrorResponse(`Parent item ${parent_item_key} not found`, {
        hint: ITEM_KEY_HINT,
      });
    }
    throw err;
  }

  if (parent.itemType === "note" || parent.itemType === "attachment") {
    return formatErrorResponse(
      `Parent item ${parent_item_key} is a ${parent.itemType}; a note can only be attached to a regular item`,
      { hint: ITEM_KEY_HINT }
    );
  }

  const payload: Record<string, unknown> = {
    itemType: "note",
    parentItem: parent_item_key,
    note: noteTextToHtml(note),
    tags: (tags ?? []).map((t) => ({ tag: t })),
    collections: [],
  };

  const response = await zoteroApi.library(libraryType, libraryId).items().post([payload]);

  if (!response.isSuccess()) {
    const errorMsg = formatWriteErrors(response.getErrors());
    return formatErrorResponse("Failed to create note", {
      details: errorMsg,
      hint: `details has Zotero's reason. parent_item_key must be an existing regular item: ${ITEM_KEY_HINT}`,
    });
  }

  const created = response.getData();
  return formatJsonResult({
    item_key: created[0].key,
    parent_item_key,
  });
}
