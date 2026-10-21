import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { formatWriteErrors } from "../utils/write-results.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { COLLECTION_KEY_HINT, ITEM_KEY_HINT } from "../utils/error-hints.js";

export const toolConfig = {
  name: "add_linked_url_attachment",
  description:
    "Attach a linked URL to an existing Zotero item, or create a standalone linked-URL attachment. Use this to link external PDFs, web pages, or other resources to items already in your library. If parent_item is provided, the attachment is added as a child; otherwise it is standalone. A linked URL stores no file and no full text (get_item_fulltext cannot read it): to store a PDF in Zotero use import_pdf_to_zotero.",
  inputSchema: {
    url: z.string().url().describe("URL of the resource to link"),
    title: z
      .string()
      .optional()
      .describe("Display title for the attachment (defaults to the URL)"),
    content_type: z
      .string()
      .optional()
      .describe(
        'MIME type of the linked resource (e.g. "application/pdf", "text/html")'
      ),
    parent_item: zoteroKey()
      .optional()
      .describe(
        "Key of the parent item (a regular item, not an attachment or note), from search_library or get_collection_items. If provided, the attachment becomes a child of that item."
      ),
    collections: z
      .array(zoteroKey())
      .optional()
      .describe(
        "Collection keys to add the attachment to (only used for standalone attachments, ignored when parent_item is set)"
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to the attachment"),
    ...libraryArgsSchema,
  },
} as const;

const AddLinkedUrlAttachmentSchema = z.object(toolConfig.inputSchema);

export async function handleAddLinkedUrlAttachment(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { url, title, content_type, parent_item, collections, tags, library_type, library_id } = AddLinkedUrlAttachmentSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const itemData: Record<string, unknown> = {
    itemType: "attachment",
    linkMode: "linked_url",
    title: title ?? url,
    url,
    tags: tags?.map((t) => ({ tag: t })) ?? [],
  };

  if (content_type) {
    itemData.contentType = content_type;
  }

  if (parent_item) {
    itemData.parentItem = parent_item;
    itemData.collections = [];
  } else {
    itemData.collections = collections ?? [];
  }

  const response = await zoteroApi
    .library(libraryType, libraryId)
    .items()
    .post([itemData]);

  if (!response.isSuccess()) {
    const errorMsg = formatWriteErrors(response.getErrors());
    return formatErrorResponse("Failed to create linked URL attachment", {
      details: errorMsg,
      hint: parent_item
        ? `details has Zotero's reason. parent_item must be an existing regular item, not an attachment or note: ${ITEM_KEY_HINT}`
        : `details has Zotero's reason. Check the collections keys: ${COLLECTION_KEY_HINT}`,
    });
  }

  const created = response.getData();
  const item = created[0];

  return formatJsonResult({
    item_key: item.key,
    title: item.title ?? title ?? url,
    url,
    parent_item: parent_item ?? null,
    link_mode: "linked_url",
  });
}
