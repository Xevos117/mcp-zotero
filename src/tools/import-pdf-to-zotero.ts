import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse, errorMessage, logToolError } from "../utils/error-formatter.js";
import { downloadAndUploadPdf } from "../utils/pdf-uploader.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { COLLECTION_KEY_HINT, ITEM_KEY_HINT, MISSING_API_KEY, MISSING_API_KEY_HINT, describeAnyError, zoteroStatusHint } from "../utils/error-hints.js";

export const toolConfig = {
  name: "import_pdf_to_zotero",
  description:
    "Download a PDF from a URL and upload it to Zotero storage as an imported_url attachment. Unlike linked URL attachments, imported files are stored in Zotero's storage and become fulltext-indexed (searchable via get_item_fulltext). Use this when you need the PDF content to be indexed by Zotero. The URL must lead straight to the PDF file (no login, paywall or HTML landing page); files up to 100 MB, counted against the user's Zotero file storage. For items with a DOI, find_and_attach_pdfs finds open-access PDFs by itself.",
  inputSchema: {
    url: z.string().url().describe("URL of the PDF to download and import"),
    filename: z
      .string()
      .optional()
      .describe("Filename for the attachment (default: extracted from URL or document.pdf)"),
    title: z
      .string()
      .optional()
      .describe("Display title for the attachment (default: filename)"),
    content_type: z
      .string()
      .optional()
      .default("application/pdf")
      .describe(
        'MIME type recorded on the attachment (default: "application/pdf"). This tool imports PDFs only: the downloaded file must start with %PDF- or the import is rejected, whatever this value says. Full text is extracted only for "application/pdf".'
      ),
    parent_item: zoteroKey()
      .optional()
      .describe("Item key of the parent item. If provided, the attachment becomes a child of that item."),
    collections: z
      .array(zoteroKey())
      .optional()
      .describe("Collection keys (only used for standalone attachments, ignored when parent_item is set)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to the attachment"),
    ...libraryArgsSchema,
  },
} as const;

const ImportPdfSchema = z.object(toolConfig.inputSchema);

/** Next step for an HTTP error from the site serving the PDF. */
function downloadFailureHint(status: number | undefined): string {
  if (status === 401 || status === 402 || status === 403) {
    return "The site refuses the download (login, paywall or bot protection): try an open-access copy (find_and_attach_pdfs for an item with a DOI, or a repository link), or the user downloads it in a browser and adds it in Zotero desktop.";
  }
  if (status === 404 || status === 410) return "The URL does not exist: check it for typos or find the current PDF link.";
  if (status === 429 || (status !== undefined && status >= 500)) return "The site is busy or failing: wait a minute and retry once.";
  return "Check that the URL leads straight to the PDF file and retry.";
}

/** Zotero storage step failed after the attachment record was created: say so, and what to do next. */
function uploadFailureHint(status: number | undefined, itemKey: string | undefined) {
  const next =
    status === 401 || status === 403
      ? zoteroStatusHint(status).hint
      : "Retry once after a short wait (timeouts and 5xx errors are usually temporary).";
  return {
    ...(itemKey ? { item_key: itemKey } : {}),
    hint: `${itemKey ? "An attachment record (item_key) was created without the file; a retry creates a new one, so mention it to the user (they can delete it in Zotero). " : ""}${next}`,
  };
}

export async function handleImportPdfToZotero(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { url, filename, title, content_type, parent_item, collections, tags, library_type, library_id } = ImportPdfSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const apiKey = process.env.ZOTERO_API_KEY;
  if (!apiKey) {
    return formatErrorResponse(MISSING_API_KEY, { hint: MISSING_API_KEY_HINT });
  }

  try {
    const result = await downloadAndUploadPdf(zoteroApi, libraryType, libraryId, apiKey, {
      url,
      parentItem: parent_item,
      collections,
      tags,
      filename,
      title,
      contentType: content_type,
    });

    if (!result.success) {
      switch (result.error.code) {
        case "network_error":
          return formatErrorResponse("Network error downloading file", {
            url,
            details: result.error.networkDetail,
            suggestion:
              "The site may be unreachable, block automated downloads or require a login. Retry once if it looks temporary (timeout, connection reset); otherwise try a direct PDF link from an open source (PubMed Central, arXiv, an institutional repository, the publisher's PDF link) or, for an item with a DOI, find_and_attach_pdfs. If the user has the PDF, they can add it in Zotero desktop.",
          });
        case "download_failed":
          return formatErrorResponse(`Failed to download file from URL (HTTP ${result.error.status})`, {
            url,
            status: result.error.status,
            suggestion: downloadFailureHint(result.error.status),
          });
        case "file_too_large":
          return formatErrorResponse("File exceeds 100 MB limit", {
            size_bytes: result.error.sizeBytes,
            suggestion: "This tool imports files up to 100 MB; nothing was created. The user can add larger files in Zotero desktop.",
          });
        case "storage_quota_exceeded":
          return formatErrorResponse("Zotero storage quota exceeded", {
            status: result.error.status,
            suggestion:
              "Your Zotero cloud storage is full. Free up space by deleting stored files in your Zotero library, or upgrade your storage plan at https://www.zotero.org/settings/storage. Note: item metadata and linked URL attachments do not consume storage — only imported file attachments do.",
            item_key: result.itemKey,
            note: "An attachment record (item_key) was created without the file. Tell the user: they can delete it in Zotero (or with delete_items, if deletion is enabled) and retry after freeing storage.",
          });
        case "auth_failed":
          return formatErrorResponse("Upload authorization failed", {
            status: result.error.status,
            details: result.error.networkDetail, // e.g. the timeout or connection error
            ...uploadFailureHint(result.error.status, result.itemKey),
          });
        case "upload_failed":
          return formatErrorResponse("File upload failed", {
            status: result.error.status,
            details: result.error.networkDetail, // e.g. the timeout or connection error
            ...uploadFailureHint(result.error.status, result.itemKey),
          });
        case "not_pdf":
          return formatErrorResponse("Downloaded file is not a valid PDF", {
            url,
            details: result.error.message,
            suggestion:
              "Nothing was created. The URL may redirect to an HTML page or require browser access: use the direct PDF link (on arXiv /pdf/ instead of /abs/), or for an item with a DOI try find_and_attach_pdfs.",
          });
        case "registration_failed":
          return formatErrorResponse("Upload registration failed", {
            status: result.error.status,
            details: result.error.networkDetail, // e.g. the timeout or connection error
            ...uploadFailureHint(result.error.status, result.itemKey),
          });
        case "item_creation_failed":
          return formatErrorResponse("import_pdf_to_zotero failed", {
            details: result.error.message,
            ...(result.error.status !== undefined ? { status: result.error.status } : {}),
            hint:
              result.error.status !== undefined && result.error.status !== 400
                ? `Nothing was created. ${zoteroStatusHint(result.error.status).hint}`
                : parent_item
                  ? `Zotero refused to create the attachment (details). parent_item must be an existing regular item, not an attachment or note: ${ITEM_KEY_HINT}`
                  : `Zotero refused to create the attachment (details). Check the collections keys: ${COLLECTION_KEY_HINT}`,
          });
      }
    }

    return formatJsonResult({
      item_key: result.itemKey,
      filename: result.filename,
      title: title ?? result.filename,
      url,
      parent_item: parent_item ?? null,
      size_bytes: result.sizeBytes,
      link_mode: "imported_url",
      fulltext_indexed: result.fulltextIndexed,
      fulltext_status: result.fulltextStatus,
    });
  } catch (err) {
    logToolError("import_pdf_to_zotero", err);
    const { error, ...described } = describeAnyError(err);
    return formatErrorResponse(`import_pdf_to_zotero failed: ${error}`, { ...described, details: errorMessage(err) });
  }
}
