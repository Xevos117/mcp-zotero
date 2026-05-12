import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { getLibraryType } from "../utils/library-context.js";

export const toolConfig = {
  name: "add_linked_url_attachment",
  description:
    "Attach a linked URL to an existing Zotero item, or create a standalone linked-URL attachment. Use this to link external PDFs, web pages, or other resources to items already in your library. If parent_item is provided, the attachment is added as a child; otherwise it is standalone.",
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
    parent_item: z
      .string()
      .optional()
      .describe(
        "Item key of the parent item. If provided, the attachment becomes a child of that item."
      ),
    collections: z
      .array(z.string())
      .optional()
      .describe(
        "Collection keys to add the attachment to (only used for standalone attachments, ignored when parent_item is set)"
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to the attachment"),
  },
} as const;

const AddLinkedUrlAttachmentSchema = z.object(toolConfig.inputSchema);

export async function handleAddLinkedUrlAttachment(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { url, title, content_type, parent_item, collections, tags } =
    AddLinkedUrlAttachmentSchema.parse(args);

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

  try {
    const response = await zoteroApi
      .library(getLibraryType(), userId)
      .items()
      .post([itemData]);

    if (!response.isSuccess()) {
      const errors = response.getErrors();
      const errorMsg = Object.values(errors).join("; ") || "Unknown error";
      return formatErrorResponse("Failed to create linked URL attachment", {
        details: errorMsg,
      });
    }

    const created = response.getData();
    const item = created[0];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              item_key: item.key,
              title: item.title ?? title ?? url,
              url,
              parent_item: parent_item ?? null,
              link_mode: "linked_url",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    if (isZoteroApiError(err)) {
      logger.error("Tool execution failed", {
        tool: "add_linked_url_attachment",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}
