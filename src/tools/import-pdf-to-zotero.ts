import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { downloadAndUploadPdf } from "../utils/pdf-uploader.js";

export const toolConfig = {
  name: "import_pdf_to_zotero",
  description:
    "Download a PDF from a URL and upload it to Zotero storage as an imported_url attachment. Unlike linked URL attachments, imported files are stored in Zotero's storage and become fulltext-indexed (searchable via get_item_fulltext). Use this when you need the PDF content to be indexed by Zotero.",
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
      .describe('MIME type of the file (default: "application/pdf")'),
    parent_item: z
      .string()
      .optional()
      .describe("Item key of the parent item. If provided, the attachment becomes a child of that item."),
    collections: z
      .array(z.string())
      .optional()
      .describe("Collection keys (only used for standalone attachments, ignored when parent_item is set)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to the attachment"),
  },
} as const;

const ImportPdfSchema = z.object(toolConfig.inputSchema);

export async function handleImportPdfToZotero(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { url, filename, title, content_type, parent_item, collections, tags } =
    ImportPdfSchema.parse(args);

  const apiKey = process.env.ZOTERO_API_KEY;
  if (!apiKey) {
    return formatErrorResponse("ZOTERO_API_KEY environment variable is not set");
  }

  try {
    const result = await downloadAndUploadPdf(zoteroApi, userId, apiKey, {
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
              "The server may be blocking automated requests, the URL may redirect to an HTML page, or it may require authentication. Try a direct PDF link from another source (e.g. PubMed Central, Sci-Hub, or the publisher's direct PDF endpoint).",
          });
        case "download_failed":
          return formatErrorResponse("Failed to download file from URL", {
            url,
            status: result.error.status,
          });
        case "file_too_large":
          return formatErrorResponse("File exceeds 100 MB limit", {
            size_bytes: result.error.sizeBytes,
          });
        case "storage_quota_exceeded":
          return formatErrorResponse("Zotero storage quota exceeded", {
            status: result.error.status,
            suggestion:
              "Your Zotero cloud storage is full. Free up space by deleting stored files in your Zotero library, or upgrade your storage plan at https://www.zotero.org/settings/storage. Note: item metadata and linked URL attachments do not consume storage — only imported file attachments do.",
            item_key: result.itemKey,
            note: "An attachment metadata record was created but the file could not be uploaded. You may want to delete it with delete_items or retry after freeing storage.",
          });
        case "auth_failed":
          return formatErrorResponse("Upload authorization failed", {
            status: result.error.status,
          });
        case "upload_failed":
          return formatErrorResponse("File upload failed", {
            status: result.error.status,
          });
        case "not_pdf":
          return formatErrorResponse("Downloaded file is not a valid PDF", {
            url,
            details: result.error.message,
            suggestion: "The URL may redirect to an HTML page or require browser access. Try a direct PDF link.",
          });
        case "registration_failed":
          return formatErrorResponse("Upload registration failed", {
            status: result.error.status,
          });
        case "item_creation_failed":
          return formatErrorResponse("import_pdf_to_zotero failed", {
            details: result.error.message,
          });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              item_key: result.itemKey,
              filename: result.filename,
              title: title ?? result.filename,
              url,
              parent_item: parent_item ?? null,
              size_bytes: result.sizeBytes,
              link_mode: "imported_url",
              fulltext_indexed: result.fulltextIndexed,
              fulltext_status: result.fulltextStatus,
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
        tool: "import_pdf_to_zotero",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResponse("import_pdf_to_zotero failed", {
      details: message,
    });
  }
}
