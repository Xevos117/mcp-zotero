import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { lookupOaPdfWithFallbacks } from "../utils/unpaywall.js";
import { downloadAndUploadPdf } from "../utils/pdf-uploader.js";
import { mapWithConcurrency, createCancellationToken } from "../utils/concurrency.js";
import { fetchAllPages } from "../utils/pagination.js";
import { getLibraryType, resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "find_and_attach_pdfs",
  description:
    "For each Zotero item, check Unpaywall for open access PDFs and attach them. Items must have a DOI. Uses the same source as Zotero Desktop's 'Find Available PDFs'.",
  inputSchema: {
    item_keys: z
      .array(z.string())
      .optional()
      .describe("Array of Zotero item keys to process (mutually exclusive with collection_key)"),
    collection_key: z
      .string()
      .optional()
      .describe("Process all items in this collection (mutually exclusive with item_keys)"),
    skip_if_attachment_exists: z
      .boolean()
      .default(true)
      .describe("Skip items that already have a PDF attachment"),
    dry_run: z
      .boolean()
      .default(false)
      .describe("Only report which PDFs are available without downloading/attaching"),
    ...libraryArgsSchema,
  },
} as const;

const FindAndAttachPdfsSchema = z.object(toolConfig.inputSchema);

interface ItemResult {
  item_key: string;
  doi: string | null;
  status: "attached" | "available" | "not_found" | "skipped" | "error" | "quota_exceeded";
  reason?: string;
  source?: string;
  pdf_url?: string;
  landing_url?: string;
  oa_status?: string;
}

export async function handleFindAndAttachPdfs(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { item_keys, collection_key, skip_if_attachment_exists, dry_run, library_type, library_id } = FindAndAttachPdfsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  // Validate: exactly one of item_keys or collection_key
  if (item_keys && collection_key) {
    return formatErrorResponse("Provide either item_keys or collection_key, not both");
  }
  if (!item_keys && !collection_key) {
    return formatErrorResponse("Provide either item_keys or collection_key");
  }

  const apiKey = process.env.ZOTERO_API_KEY;
  if (!apiKey) {
    return formatErrorResponse("ZOTERO_API_KEY environment variable is not set");
  }

  try {
    // 1. Resolve item keys
    let keys: string[];
    if (collection_key) {
      const { items: collItems } = await fetchAllPages((params) =>
        zoteroApi.library(libraryType, libraryId).collections(collection_key).items().get(params)
      );
      keys = collItems
        .filter((item) => item.itemType !== "attachment" && item.itemType !== "note")
        .map((item) => item.key as string)
        .filter(Boolean);
    } else {
      keys = item_keys as string[];
    }

    if (keys.length === 0) {
      return formatErrorResponse("No items to process");
    }

    // 2. Batch-fetch item metadata to get DOIs
    const metaResponse = await zoteroApi
      .library(libraryType, libraryId)
      .items()
      .get({ itemKey: keys.join(",") });
    const metaItems = metaResponse.getData() as ZoteroItemData[];
    const itemsArray = Array.isArray(metaItems) ? metaItems : [metaItems];

    const itemMap = new Map<string, ZoteroItemData>();
    for (const item of itemsArray) {
      if (item.key) {
        itemMap.set(item.key, item);
      }
    }

    // 3. Process each item in parallel
    const cancelToken = createCancellationToken();

    const settled = await mapWithConcurrency(keys, async (key): Promise<ItemResult> => {
      const item = itemMap.get(key);
      if (!item) {
        return { item_key: key, doi: null, status: "error", reason: "Item not found" };
      }

      const doi = item.DOI ?? null;
      if (!doi) {
        return { item_key: key, doi: null, status: "error", reason: "No DOI" };
      }

      // Check for existing attachments
      if (skip_if_attachment_exists) {
        const childrenResponse = await zoteroApi
          .library(libraryType, libraryId)
          .items(key)
          .children()
          .get();
        const children = childrenResponse.getData() as ZoteroItemData[];
        const childrenArray = Array.isArray(children) ? children : [children];
        const hasPdf = childrenArray.some(
          (child) =>
            child.itemType === "attachment" && child.contentType === "application/pdf"
        );
        if (hasPdf) {
          return { item_key: key, doi, status: "skipped", reason: "PDF attachment already exists" };
        }
      }

      // Lookup OA PDF
      const { primary, fallback_urls } = await lookupOaPdfWithFallbacks(doi);

      if (!primary.found || !primary.pdf_url) {
        let reason: string;
        if (primary.warning) {
          reason = primary.warning;
        } else if (primary.landing_url) {
          reason = "Open access copy exists at a repository but no direct PDF link is available. If the user needs this PDF, they can download it manually from the landing page and use import_pdf_to_zotero to attach it.";
        } else if (primary.oa_status) {
          reason = `OA status: ${primary.oa_status}`;
        } else {
          reason = "No open access PDF found";
        }
        return {
          item_key: key,
          doi,
          status: "not_found",
          reason,
          ...(primary.landing_url ? { landing_url: primary.landing_url } : {}),
          ...(primary.oa_status ? { oa_status: primary.oa_status } : {}),
        };
      }

      if (dry_run) {
        return {
          item_key: key,
          doi,
          status: "available",
          source: primary.source ?? undefined,
          pdf_url: primary.pdf_url,
        };
      }

      // Try primary URL, then fallbacks
      const urlsToTry = [primary.pdf_url, ...fallback_urls];

      for (const pdfUrl of urlsToTry) {
        const uploadResult = await downloadAndUploadPdf(zoteroApi, libraryType, libraryId, apiKey, {
          url: pdfUrl,
          parentItem: key,
        });

        if (uploadResult.success) {
          return {
            item_key: key,
            doi,
            status: "attached",
            source: primary.source ?? undefined,
            pdf_url: pdfUrl,
          };
        }

        if (!uploadResult.success && uploadResult.error.code === "storage_quota_exceeded") {
          cancelToken.cancelled = true;
          return {
            item_key: key,
            doi,
            status: "quota_exceeded",
            reason: uploadResult.error.message,
          };
        }
      }

      return {
        item_key: key,
        doi,
        status: "error",
        reason: `Download failed for all ${urlsToTry.length} URL(s)`,
        source: primary.source ?? undefined,
      };
    }, undefined, cancelToken);

    const results: ItemResult[] = settled
      .filter((r): r is PromiseFulfilledResult<ItemResult> => r.status === "fulfilled")
      .map((r) => r.value);

    let attached = 0;
    let notFound = 0;
    let skipped = 0;
    let errors = 0;
    let quotaExceeded = 0;
    for (const r of results) {
      if (r.status === "attached") attached++;
      else if (r.status === "not_found") notFound++;
      else if (r.status === "skipped") skipped++;
      else if (r.status === "error") errors++;
      else if (r.status === "quota_exceeded") quotaExceeded++;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              processed: keys.length,
              attached,
              not_found: notFound,
              skipped,
              errors,
              quota_exceeded: quotaExceeded,
              dry_run,
              ...(quotaExceeded > 0
                ? {
                    storage_quota_warning:
                      "Zotero storage quota is full. Remaining PDF uploads were skipped. Free up space at https://www.zotero.org/settings/storage or upgrade your plan.",
                  }
                : {}),
              results,
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
        tool: "find_and_attach_pdfs",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResponse("find_and_attach_pdfs failed", { details: message });
  }
}
