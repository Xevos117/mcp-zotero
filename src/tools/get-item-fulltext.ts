import { InvalidJsonResponseError, readJsonObject } from "../utils/json-response.js";
import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface, ZoteroItemData, ZoteroFulltextResponse, isZoteroApiError } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { resolveLibrary, libraryArgsSchema, LibraryType } from "../utils/library-context.js";
import { findPdfAttachments, isLinkedUrl, isPdfAttachment } from "../utils/attachments.js";
import { fetchWithTimeout, isTimeoutAbort, timeoutError, TIMEOUTS } from "../utils/timeouts.js";
import { ITEM_KEY_HINT, MISSING_API_KEY, MISSING_API_KEY_HINT, zoteroStatusHint } from "../utils/error-hints.js";

export const toolConfig = {
  name: "get_item_fulltext",
  description:
    "Get the text of a Zotero item's stored PDF from Zotero's full-text index. Works for PDFs indexed by Zotero desktop and synced, or imported with import_pdf_to_zotero / find_and_attach_pdfs; not for linked URLs or web pages. Use this to read the full content of papers instead of relying on abstracts.",
  inputSchema: {
    item_key: zoteroKey().describe("Item key (the parent item or its PDF attachment), from search_library or get_collection_items"),
    max_characters: z
      .number()
      .optional()
      .default(50000)
      .describe("Maximum characters to return (default: 50000, 0 = no limit); truncated: true in the result when cut"),
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
    return formatErrorResponse(MISSING_API_KEY, { hint: MISSING_API_KEY_HINT });
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
          "This attachment is a link to a PDF on the web (linked URL): Zotero stores no file or full text for it. Fetch the URL directly if you have a web tool, or store the PDF with import_pdf_to_zotero and call again.",
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
        "No stored PDF attachment found. This item only links to a PDF on the web (linked URL attachment), which Zotero does not index — fetch the linked URL directly if you have a web tool, or store the PDF with import_pdf_to_zotero (parent_item = this item) and call again.",
        { item_key, attachment_key: linkedPdf.key, url: linkedPdf.url || undefined }
      );
    }

    if (!pdfAttachment?.key) {
      // Provide context-aware error messages
      if (itemData.itemType === "webpage" || itemData.itemType === "blogPost") {
        return formatErrorResponse(
          "This is a web page item: Zotero has no PDF text for it. Fetch its URL directly if you have a web tool; otherwise tell the user.",
          { item_key, url: itemData.url || undefined }
        );
      }
      if (itemData.url) {
        return formatErrorResponse(
          "No PDF attachment found. This item has a URL — you can fetch its content directly from the web, or attach the PDF " +
            "(find_and_attach_pdfs if the item has a DOI, import_pdf_to_zotero for a PDF URL) and call again.",
          { item_key, url: itemData.url }
        );
      }
      return formatErrorResponse(
        "No PDF attachment found for this item. Attach one with find_and_attach_pdfs (items with a DOI) or import_pdf_to_zotero (a PDF URL), then call again.",
        { item_key }
      );
    }

    return fetchFulltext(item_key, pdfAttachment.key, libraryType, libraryId, apiKey, max_characters);
  } catch (err) {
    if (isZoteroApiError(err)) {
      if (err.response?.status === 404) {
        return formatErrorResponse("Item not found in this library", { item_key, hint: ITEM_KEY_HINT });
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
      "Full text not indexed for this item: Zotero has no text for this PDF yet. Retrying now will not help.",
      {
        item_key: itemKey,
        attachment_key: attachmentKey,
        hint:
          "Tell the user to open the PDF in Zotero desktop (or right-click it → Reindex Item) and let Zotero sync, then try again. " +
          "A scanned PDF without a text layer cannot be indexed.",
      }
    );
  }

  if (!response.ok) {
    const { error, hint } = zoteroStatusHint(response.status);
    return formatErrorResponse(`Zotero fulltext API returned status ${response.status}. ${error}`, {
      item_key: itemKey,
      attachment_key: attachmentKey,
      hint,
    });
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
      hint: "Retry once; large PDFs can be slow. If it keeps timing out, tell the user to check the network connection of the machine running this server.",
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
