import { createHash } from "node:crypto";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { logger } from "./logger.js";
import { extractPdfText } from "./pdf-text-extractor.js";
import { putFulltext } from "./zotero-fulltext.js";
import { formatWriteErrors } from "./write-results.js";
import { LibraryType } from "./library-context.js";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

interface UploadAuthResponse {
  url: string;
  contentType: string;
  prefix: string;
  suffix: string;
  uploadKey: string;
}

export interface PdfUploadOptions {
  url: string;
  parentItem?: string;
  collections?: string[];
  tags?: string[];
  filename?: string;
  title?: string;
  contentType?: string;
  /** DOI of the parent item, used for the filename when neither URL nor server provide one. */
  doi?: string;
}

export type PdfUploadErrorCode =
  | "network_error"
  | "download_failed"
  | "not_pdf"
  | "file_too_large"
  | "item_creation_failed"
  | "auth_failed"
  | "storage_quota_exceeded"
  | "upload_failed"
  | "registration_failed";

export interface PdfUploadError {
  code: PdfUploadErrorCode;
  message: string;
  status?: number;
  sizeBytes?: number;
  detectedContentType?: string;
  networkDetail?: string;
}

export interface PdfUploadSuccess {
  success: true;
  itemKey: string;
  filename: string;
  sizeBytes: number;
  fulltextIndexed: boolean;
  fulltextStatus: string;
}

export interface PdfUploadFailure {
  success: false;
  error: PdfUploadError;
  itemKey?: string;
}

export type PdfUploadResult = PdfUploadSuccess | PdfUploadFailure;

function safeBasename(name: string): string {
  return (name.split(/[\\/]/).pop() ?? "").replace(/[\x00-\x1f"]/g, "").trim();
}

function filenameFromContentDisposition(header: string | null): string {
  if (!header) return "";
  const extended = /filename\*\s*=\s*[\w-]*'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return safeBasename(decodeURIComponent(extended[1].trim()));
    } catch {
      // malformed percent-encoding: fall back to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return plain ? safeBasename(plain[1] ?? plain[2]) : "";
}

/**
 * Attachment filename, in order: the URL basename when it ends in .pdf, the Content-Disposition
 * filename, "<sanitized DOI>.pdf", "document.pdf". URLs such as PLOS ".../article/file?id=..."
 * carry no usable name in the path.
 */
export function resolvePdfFilename(url: string, contentDisposition: string | null, doi?: string): string {
  try {
    const basename = safeBasename(decodeURIComponent(new URL(url).pathname));
    if (/\.pdf$/i.test(basename)) return basename;
  } catch {
    // invalid URL or percent-encoding: try the other sources
  }
  const fromHeader = filenameFromContentDisposition(contentDisposition);
  if (fromHeader) return /\.[a-z0-9]+$/i.test(fromHeader) ? fromHeader : `${fromHeader}.pdf`;
  if (doi) return `${doi.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`;
  return "document.pdf";
}

/**
 * Download a PDF from a URL and upload it to Zotero storage.
 * Handles the full 7-step flow: download → validate → create item → auth → upload → register → fulltext.
 */
export async function downloadAndUploadPdf(
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  userId: string,
  apiKey: string,
  options: PdfUploadOptions
): Promise<PdfUploadResult> {
  const contentType = options.contentType ?? "application/pdf";

  // 1. Download the file
  let downloadResponse: Response;
  try {
    downloadResponse = await fetch(options.url, {
      headers: {
        "User-Agent": "mcp-zotero/1.0 (Open Access PDF retrieval)",
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: "network_error",
        message: `Network error downloading file: ${detail}. The server may be blocking automated requests, the URL may redirect to an HTML page, or it may require authentication.`,
        networkDetail: detail,
      },
    };
  }

  if (!downloadResponse.ok) {
    return {
      success: false,
      error: {
        code: "download_failed",
        message: `Failed to download file from URL (status ${downloadResponse.status})`,
        status: downloadResponse.status,
      },
    };
  }

  const responseContentType = downloadResponse.headers.get("content-type") ?? "";
  if (!responseContentType.includes("application/pdf") && !responseContentType.includes("application/octet-stream")) {
    logger.warn("Unexpected Content-Type for PDF download", {
      url: options.url,
      contentType: responseContentType,
    });
  }

  const arrayBuffer = await downloadResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filename =
    options.filename ??
    resolvePdfFilename(options.url, downloadResponse.headers.get("content-disposition"), options.doi);
  const title = options.title ?? filename;

  // 2. Validate PDF magic bytes
  const PDF_MAGIC = Buffer.from("%PDF-");
  if (buffer.length < 5 || buffer.subarray(0, 5).compare(PDF_MAGIC) !== 0) {
    const detectedContentType = downloadResponse.headers.get("content-type") ?? "unknown";
    const preview = buffer.subarray(0, 200).toString("utf-8");
    const looksHtml = preview.toLowerCase().includes("<html") || preview.toLowerCase().includes("<!doctype");
    return {
      success: false,
      error: {
        code: "not_pdf",
        message: looksHtml
          ? `The server returned an HTML page instead of a PDF (Content-Type: ${detectedContentType}). The URL may require browser access, authentication, or redirect to a landing page.`
          : `Downloaded file is not a valid PDF (Content-Type: ${detectedContentType}, missing %PDF- header). The URL may not point to a direct PDF download.`,
        detectedContentType,
      },
    };
  }

  // 3. Validate size
  if (buffer.length > MAX_FILE_SIZE) {
    return {
      success: false,
      error: {
        code: "file_too_large",
        message: `File exceeds 100 MB limit (${buffer.length} bytes)`,
        sizeBytes: buffer.length,
      },
    };
  }

  // 3. Compute md5
  const md5 = createHash("md5").update(buffer).digest("hex");

  // 4. Create attachment item via Zotero API
  const itemData: Record<string, unknown> = {
    itemType: "attachment",
    linkMode: "imported_url",
    title,
    url: options.url,
    contentType,
    filename,
    tags: options.tags?.map((t) => ({ tag: t })) ?? [],
  };

  if (options.parentItem) {
    itemData.parentItem = options.parentItem;
    itemData.collections = [];
  } else {
    itemData.collections = options.collections ?? [];
  }

  let createResponse;
  try {
    createResponse = await zoteroApi
      .library(libraryType, userId)
      .items()
      .post([itemData]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: "item_creation_failed" as const,
        message: `Failed to create attachment item: ${detail}`,
        networkDetail: detail,
      },
    };
  }

  if (!createResponse.isSuccess()) {
    const errorMsg = formatWriteErrors(createResponse.getErrors());
    return {
      success: false,
      error: {
        code: "item_creation_failed",
        message: `Failed to create attachment item: ${errorMsg}`,
      },
    };
  }

  const created = createResponse.getData();
  const itemKey = created[0].key as string;

  // 5. Upload authorization
  const authUrl = `https://api.zotero.org/${libraryType}s/${userId}/items/${itemKey}/file`;
  const authBody = new URLSearchParams({
    md5,
    filename,
    filesize: String(buffer.length),
    mtime: String(Date.now()),
  });

  let authResponse: Response;
  try {
    authResponse = await fetch(authUrl, {
      method: "POST",
      headers: {
        "Zotero-API-Key": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "If-None-Match": "*",
      },
      body: authBody.toString(),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      itemKey,
      error: {
        code: "auth_failed",
        message: `Upload authorization failed: ${detail}`,
        networkDetail: detail,
      },
    };
  }

  if (!authResponse.ok) {
    if (authResponse.status === 413) {
      return {
        success: false,
        itemKey,
        error: {
          code: "storage_quota_exceeded",
          message: "Zotero storage quota exceeded. The file cannot be uploaded because your Zotero cloud storage is full. Free up space by deleting stored files in Zotero, or upgrade your storage plan at https://www.zotero.org/settings/storage.",
          status: 413,
        },
      };
    }
    return {
      success: false,
      itemKey,
      error: {
        code: "auth_failed",
        message: `Upload authorization failed (status ${authResponse.status})`,
        status: authResponse.status,
      },
    };
  }

  const authData = (await authResponse.json()) as UploadAuthResponse | { exists: 1 };

  // 6-7. Upload binary + register (skip if already exists)
  if (!("exists" in authData)) {
    const auth = authData as UploadAuthResponse;

    const prefix = Buffer.from(auth.prefix, "utf-8");
    const suffix = Buffer.from(auth.suffix, "utf-8");
    const uploadBody = Buffer.concat([prefix, buffer, suffix]);

    let uploadResponse: Response;
    try {
      uploadResponse = await fetch(auth.url, {
        method: "POST",
        headers: { "Content-Type": auth.contentType },
        body: uploadBody,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        itemKey,
        error: {
          code: "upload_failed",
          message: `File upload failed: ${detail}`,
          networkDetail: detail,
        },
      };
    }

    if (!uploadResponse.ok) {
      return {
        success: false,
        itemKey,
        error: {
          code: "upload_failed",
          message: `File upload failed (status ${uploadResponse.status})`,
          status: uploadResponse.status,
        },
      };
    }

    let registerResponse: Response;
    try {
      registerResponse = await fetch(authUrl, {
        method: "POST",
        headers: {
          "Zotero-API-Key": apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
          "If-None-Match": "*",
        },
        body: `upload=${auth.uploadKey}`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        itemKey,
        error: {
          code: "registration_failed",
          message: `Upload registration failed: ${detail}`,
          networkDetail: detail,
        },
      };
    }

    if (!registerResponse.ok) {
      return {
        success: false,
        itemKey,
        error: {
          code: "registration_failed",
          message: `Upload registration failed (status ${registerResponse.status})`,
          status: registerResponse.status,
        },
      };
    }
  }

  // 8. Extract text and index fulltext
  let fulltextIndexed = false;
  let fulltextStatus: string;

  if (contentType === "application/pdf") {
    try {
      const { text, totalPages } = await extractPdfText(buffer);
      const putResult = await putFulltext(libraryType, userId, itemKey, apiKey, text, totalPages);
      fulltextIndexed = putResult.success;
      fulltextStatus = putResult.success
        ? "Fulltext indexed successfully. Use get_item_fulltext to retrieve content."
        : `Fulltext PUT failed: ${putResult.error}. Sync with Zotero Desktop to index the PDF.`;
    } catch {
      fulltextStatus = "PDF text extraction failed. Sync with Zotero Desktop to index the PDF.";
    }
  } else {
    fulltextStatus = "Non-PDF content type, fulltext extraction skipped.";
  }

  logger.info("PDF uploaded successfully", { itemKey, filename, sizeBytes: buffer.length });

  return {
    success: true,
    itemKey,
    filename,
    sizeBytes: buffer.length,
    fulltextIndexed,
    fulltextStatus,
  };
}
