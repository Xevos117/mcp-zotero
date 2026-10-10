import { ZoteroApiInterface } from "../types/zotero-types.js";
import { LibraryType } from "./library-context.js";
import { downloadAndUploadPdf, PdfUploadOptions, PdfUploadSuccess } from "./pdf-uploader.js";

export interface PdfUrlFailure {
  url: string;
  error: string;
}

export type PdfAttemptResult =
  | { attached: true; pdfUrl: string; upload: PdfUploadSuccess }
  | { attached: false; quotaExceeded: boolean; message: string; failedUrls: PdfUrlFailure[] };

/**
 * Try candidate PDF URLs in order (Unpaywall primary first, then the fallbacks) until one is
 * downloaded and uploaded. Stops early on a storage-quota error, which no other URL can fix.
 */
export async function uploadFirstAvailablePdf(
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  libraryId: string,
  apiKey: string,
  urls: string[],
  options: Omit<PdfUploadOptions, "url">
): Promise<PdfAttemptResult> {
  const failedUrls: PdfUrlFailure[] = [];
  for (const url of urls) {
    const upload = await downloadAndUploadPdf(zoteroApi, libraryType, libraryId, apiKey, { ...options, url });
    if (upload.success) return { attached: true, pdfUrl: url, upload };
    failedUrls.push({ url, error: upload.error.message });
    if (upload.error.code === "storage_quota_exceeded") {
      return { attached: false, quotaExceeded: true, message: upload.error.message, failedUrls };
    }
  }
  const message =
    failedUrls.length === 1 ? failedUrls[0].error : `Download failed for all ${failedUrls.length} URL(s)`;
  return { attached: false, quotaExceeded: false, message, failedUrls };
}
