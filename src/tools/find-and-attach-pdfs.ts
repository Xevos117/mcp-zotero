import { z } from "zod";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { formatEmptyResult, formatErrorResponse } from "../utils/error-formatter.js";
import { logger } from "../utils/logger.js";
import { OaPdfResult, OaPdfTarget, attachOpenAccessPdfs } from "../utils/oa-pdf.js";
import { fetchAllPages, fetchItemsByKeys } from "../utils/pagination.js";
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

/** Shared pipeline result, plus `pdf_url` kept as an alias of `url_used` for existing clients. */
type ItemResult = OaPdfResult & { pdf_url?: string };

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
      return formatEmptyResult("No items to process");
    }

    // 2. Batch-fetch item metadata to get DOIs
    const { items: metaItems } = await fetchItemsByKeys(
      (params) => zoteroApi.library(libraryType, libraryId).items().get(params),
      keys
    );

    const itemMap = new Map<string, ZoteroItemData>();
    for (const item of metaItems) {
      if (item.key) {
        itemMap.set(item.key, item);
      }
    }

    // 3. Items without metadata or DOI are reported directly; the others go through the shared pipeline
    const preResults = new Map<string, ItemResult>();
    const targets: OaPdfTarget[] = [];
    for (const key of keys) {
      const item = itemMap.get(key);
      if (!item) preResults.set(key, { item_key: key, doi: null, status: "error", reason: "Item not found" });
      else if (!item.DOI) preResults.set(key, { item_key: key, doi: null, status: "error", reason: "No DOI" });
      else targets.push({ itemKey: key, doi: item.DOI });
    }

    const pipelineResults = await attachOpenAccessPdfs(targets, {
      zoteroApi,
      library: { type: libraryType, id: libraryId },
      apiKey,
      skipIfPdfExists: skip_if_attachment_exists,
      dryRun: dry_run,
    });
    const byKey = new Map(pipelineResults.map((r) => [r.item_key, r]));
    const results: ItemResult[] = keys.flatMap((key) => {
      const r = preResults.get(key) ?? byKey.get(key);
      if (!r) return []; // not started: storage quota exhausted
      return [r.url_used ? { ...r, pdf_url: r.url_used } : r];
    });

    let attached = 0;
    let notFound = 0;
    let skipped = 0;
    let errors = 0;
    let quotaExceeded = 0;
    for (const r of results) {
      if (r.status === "attached") attached++;
      else if (r.status === "not_found" || r.status === "landing_page_only") notFound++;
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
