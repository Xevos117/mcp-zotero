import { ZoteroApiInterface, ZoteroItemData } from "../types/zotero-types.js";
import { CancellationToken, createCancellationToken, mapWithConcurrency, settledValues } from "./concurrency.js";
import { LibraryType } from "./library-context.js";
import { downloadAndUploadPdf } from "./pdf-uploader.js";
import { landingPageOnlyReason, lookupOaPdfWithFallbacks } from "./unpaywall.js";

/**
 * Shared open-access PDF pipeline used by add_items_by_doi and find_and_attach_pdfs:
 * Unpaywall lookup → primary URL then every fallback in order → download (PDF checks, filename,
 * upload as child attachment, fulltext indexing in downloadAndUploadPdf) → one result shape.
 */

export interface PdfUrlFailure {
  url: string;
  error: string;
}

export type OaPdfStatus =
  | "attached"
  | "available"
  | "skipped"
  | "not_found"
  | "landing_page_only"
  | "quota_exceeded"
  | "error";

/** Per-item outcome, identical in every tool that attaches open-access PDFs. */
export interface OaPdfResult {
  item_key: string;
  doi: string | null;
  status: OaPdfStatus;
  reason?: string;
  source?: string;
  /** PDF URL that was attached (or would be, in a dry run). */
  url_used?: string;
  filename?: string;
  size_bytes?: number;
  attachment_key?: string;
  fulltext_indexed?: boolean;
  landing_url?: string;
  oa_status?: string;
  /** Every URL tried without success, with its error. */
  failed_urls?: PdfUrlFailure[];
}

export interface OaPdfTarget {
  itemKey: string;
  doi: string;
}

export interface OaPdfOptions {
  zoteroApi: ZoteroApiInterface;
  library: { type: LibraryType; id: string };
  apiKey: string;
  /** Skip items that already have a PDF attachment. */
  skipIfPdfExists?: boolean;
  /** Report the PDF that would be attached without downloading it. */
  dryRun?: boolean;
  /** Set when the storage quota is exhausted, so no new uploads are started. */
  cancel?: CancellationToken;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function hasPdfAttachment({ zoteroApi, library }: OaPdfOptions, itemKey: string): Promise<boolean> {
  const response = await zoteroApi.library(library.type, library.id).items(itemKey).children().get();
  const data = response.getData() as ZoteroItemData | ZoteroItemData[];
  const children = Array.isArray(data) ? data : [data];
  return children.some((child) => child?.itemType === "attachment" && child.contentType === "application/pdf");
}

/** Find and attach the open-access PDF of one item. */
export async function attachOpenAccessPdf(target: OaPdfTarget, opts: OaPdfOptions): Promise<OaPdfResult> {
  const base = { item_key: target.itemKey, doi: target.doi };

  if (opts.skipIfPdfExists && (await hasPdfAttachment(opts, target.itemKey))) {
    return { ...base, status: "skipped", reason: "PDF attachment already exists" };
  }

  const { primary, fallback_urls } = await lookupOaPdfWithFallbacks(target.doi);
  const oaStatus = primary.oa_status ? { oa_status: primary.oa_status } : {};
  if (primary.warning) {
    return { ...base, status: "not_found", reason: primary.warning };
  }
  if (!primary.found || !primary.pdf_url) {
    return primary.landing_url
      ? { ...base, status: "landing_page_only", reason: landingPageOnlyReason(primary), landing_url: primary.landing_url, ...oaStatus }
      : { ...base, status: "not_found", reason: "No open access PDF found", ...oaStatus };
  }

  const source = primary.source ?? undefined;
  if (opts.dryRun) {
    return { ...base, status: "available", source, url_used: primary.pdf_url };
  }

  const failed_urls: PdfUrlFailure[] = [];
  for (const url of [primary.pdf_url, ...fallback_urls]) {
    const upload = await downloadAndUploadPdf(opts.zoteroApi, opts.library.type, opts.library.id, opts.apiKey, {
      url,
      parentItem: target.itemKey,
      doi: target.doi,
    });
    if (upload.success) {
      return {
        ...base,
        status: "attached",
        source,
        url_used: url,
        filename: upload.filename,
        size_bytes: upload.sizeBytes,
        attachment_key: upload.itemKey,
        fulltext_indexed: upload.fulltextIndexed,
      };
    }
    failed_urls.push({ url, error: upload.error.message });
    if (upload.error.code === "storage_quota_exceeded") {
      // No other URL can fix a full storage quota
      if (opts.cancel) opts.cancel.cancelled = true;
      return { ...base, status: "quota_exceeded", source, reason: upload.error.message, failed_urls };
    }
  }

  const reason = failed_urls.length === 1 ? failed_urls[0].error : `Download failed for all ${failed_urls.length} URL(s)`;
  return { ...base, status: "error", source, reason, failed_urls };
}

/**
 * Run the pipeline over many items with bounded concurrency. An unexpected error becomes that
 * item's "error" result; items never started because the storage quota ran out are omitted.
 */
export async function attachOpenAccessPdfs(targets: OaPdfTarget[], opts: OaPdfOptions): Promise<OaPdfResult[]> {
  const cancel = opts.cancel ?? createCancellationToken();
  const settled = await mapWithConcurrency(
    targets,
    (target) => attachOpenAccessPdf(target, { ...opts, cancel }),
    undefined,
    cancel
  );
  return settledValues(targets, settled, (target, reason): OaPdfResult => ({
    item_key: target.itemKey,
    doi: target.doi,
    status: "error",
    reason: errorText(reason),
  }));
}
