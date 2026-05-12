import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, ZoteroFulltextResponse, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { getLibraryType } from "../utils/library-context.js";

export const toolConfig = {
  name: "get_item_fulltext",
  description:
    "Get the full text content of a Zotero item's PDF attachment via Zotero's fulltext index. Zotero desktop automatically indexes PDFs when synced. Use this to read the full content of papers instead of relying on abstracts.",
  inputSchema: {
    item_key: z.string().describe("The Zotero item key (parent item or attachment key)"),
    max_characters: z
      .number()
      .optional()
      .default(50000)
      .describe("Maximum characters to return (default: 50000, 0 = no limit)"),
  },
} as const;

const GetItemFulltextSchema = z.object(toolConfig.inputSchema);

export async function handleGetItemFulltext(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_key, max_characters } = GetItemFulltextSchema.parse(args);

  const apiKey = process.env.ZOTERO_API_KEY;
  if (!apiKey) {
    return formatErrorResponse("ZOTERO_API_KEY environment variable is not set");
  }

  try {
    // Fetch parent item metadata for context
    const itemResponse = await zoteroApi
      .library(getLibraryType(), userId)
      .items(item_key)
      .get();

    const itemData = itemResponse.getData() as ZoteroItemData;

    // If the item itself is a PDF attachment, use it directly
    if (itemData.itemType === "attachment" && itemData.contentType === "application/pdf") {
      return fetchFulltext(item_key, item_key, userId, apiKey, max_characters);
    }

    // Fetch children to find PDF attachment
    const childrenResponse = await zoteroApi
      .library(getLibraryType(), userId)
      .items(item_key)
      .children()
      .get();

    const children = childrenResponse.getData();
    const childList = Array.isArray(children) ? children : [children];

    const pdfAttachment = childList.find(
      (child: ZoteroItemData) =>
        child.itemType === "attachment" && child.contentType === "application/pdf"
    );

    if (!pdfAttachment?.key) {
      // Provide context-aware error messages
      if (itemData.itemType === "webpage" || itemData.itemType === "blogPost") {
        return formatErrorResponse(
          "This is a web page item. Use the item's URL to fetch its content directly.",
          { item_key, url: itemData.url || undefined }
        );
      }
      if (itemData.url) {
        return formatErrorResponse(
          `No PDF attachment found. This item has a URL — you can fetch its content directly from the web.`,
          { item_key, url: itemData.url }
        );
      }
      return formatErrorResponse("No PDF attachment found for this item.", { item_key });
    }

    return fetchFulltext(item_key, pdfAttachment.key, userId, apiKey, max_characters);
  } catch (err) {
    if (isZoteroApiError(err)) {
      if (err.response?.status === 404) {
        return formatErrorResponse("Item not found", { item_key });
      }
      logger.error("Tool execution failed", {
        tool: "get_item_fulltext",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}

async function fetchFulltext(
  itemKey: string,
  attachmentKey: string,
  userId: string,
  apiKey: string,
  maxCharacters: number
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const url = `https://api.zotero.org/${getLibraryType()}s/${userId}/items/${attachmentKey}/fulltext`;
  const response = await fetch(url, {
    headers: { "Zotero-API-Key": apiKey },
  });

  if (response.status === 404) {
    return formatErrorResponse(
      "Full text not indexed for this item. Open the PDF in Zotero desktop to trigger indexing, then sync.",
      { item_key: itemKey, attachment_key: attachmentKey }
    );
  }

  if (!response.ok) {
    return formatErrorResponse(
      `Zotero fulltext API returned status ${response.status}`,
      { item_key: itemKey, attachment_key: attachmentKey }
    );
  }

  const data = (await response.json()) as ZoteroFulltextResponse;
  let text = data.content;
  let truncated = false;

  if (maxCharacters > 0 && text.length > maxCharacters) {
    text = text.slice(0, maxCharacters);
    truncated = true;
  }

  const result = {
    item_key: itemKey,
    attachment_key: attachmentKey,
    text,
    characters: text.length,
    truncated,
    ...(data.indexedPages !== undefined && { pages: data.indexedPages }),
    ...(data.totalPages !== undefined && { totalPages: data.totalPages }),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}
