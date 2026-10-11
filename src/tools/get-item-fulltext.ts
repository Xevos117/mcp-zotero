import { InvalidJsonResponseError, readJsonObject } from "../utils/json-response.js";
import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, ZoteroFulltextResponse, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { resolveLibrary, libraryArgsSchema, LibraryType } from "../utils/library-context.js";
import { findPdfAttachments, isLinkedUrl, isPdfAttachment } from "../utils/attachments.js";
import { fetchWithTimeout, isTimeoutAbort, timeoutError, TIMEOUTS } from "../utils/timeouts.js";

export const toolConfig = {
  name: "get_item_fulltext",
  description:
    "Get the full text content of a Zotero item's PDF attachment via Zotero's fulltext index. Zotero desktop automatically indexes PDFs when synced. Use this to read the full content of papers instead of relying on abstracts.",
  inputSchema: {
    item_key: zoteroKey().describe("The Zotero item key (parent item or attachment key)"),
    max_characters: z
      .number()
      .optional()
      .default(50000)
      .describe("Maximum characters to return (default: 50000, 0 = no limit)"),
    ...libraryArgsSchema,
  },
} as const;

const GetItemFulltextSchema = z.object(toolConfig.inputSchema);

export async function handleGetItemFulltext(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_key, max_characters, library_type, library_id } = GetItemFulltextSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const apiKey = process.env.ZOTERO_API_KEY;
  if (!apiKey) {
    return formatErrorResponse("ZOTERO_API_KEY environment variable is not set");
  }

  try {
    // Fetch parent item metadata for context
    const itemResponse = await zoteroApi
      .library(libraryType, libraryId)
      .items(item_key)
      .get();

    const itemData = itemResponse.getData() as ZoteroItemData;

    // If the item itself is a PDF attachment, use it directly (a web link has no stored file)
    if (isPdfAttachment(itemData)) {
      if (isLinkedUrl(itemData)) {
        return formatErrorResponse(
          "This attachment is a link to a PDF on the web (linked URL): Zotero stores no file or full text for it. Fetch the URL directly.",
          { item_key, url: itemData.url || undefined }
        );
      }
      return fetchFulltext(item_key, item_key, libraryType, libraryId, apiKey, max_characters);
    }

    // Stored PDFs first: linked URLs never have server-side full text, even when listed first
    const pdfs = await findPdfAttachments(zoteroApi, { type: libraryType, id: libraryId }, item_key);
    const pdfAttachment = pdfs.find((p) => !isLinkedUrl(p));
    const linkedPdf = pdfs.find(isLinkedUrl);

    if (!pdfAttachment?.key && linkedPdf) {
      return formatErrorResponse(
        "No stored PDF attachment found. This item only links to a PDF on the web (linked URL attachment), which Zotero does not index — fetch the linked URL directly.",
        { item_key, attachment_key: linkedPdf.key, url: linkedPdf.url || undefined }
      );
    }

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

    return fetchFulltext(item_key, pdfAttachment.key, libraryType, libraryId, apiKey, max_characters);
  } catch (err) {
    if (isZoteroApiError(err)) {
      if (err.response?.status === 404) {
        return formatErrorResponse("Item not found", { item_key });
      }
    }
    throw err;
  }
}

async function fetchFulltext(
  itemKey: string,
  attachmentKey: string,
  libraryType: LibraryType,
  userId: string,
  apiKey: string,
  maxCharacters: number
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const url = `https://api.zotero.org/${libraryType}s/${userId}/items/${attachmentKey}/fulltext`;
  const response = await fetchWithTimeout(url, { headers: { "Zotero-API-Key": apiKey } }, TIMEOUTS.zoteroApiMs, "Zotero fulltext request");

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

  let data: ZoteroFulltextResponse;
  try {
    data = await readJsonObject<ZoteroFulltextResponse>(response);
  } catch (err) {
    if (err instanceof InvalidJsonResponseError) {
      return formatErrorResponse(`Zotero fulltext API: ${err.message}`, { item_key: itemKey, attachment_key: attachmentKey });
    }
    if (!isTimeoutAbort(err)) throw err;
    return formatErrorResponse(timeoutError("Zotero fulltext request", url, TIMEOUTS.zoteroApiMs).message, {
      item_key: itemKey,
      attachment_key: attachmentKey,
    });
  }
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

  return formatJsonResult(result);
}
