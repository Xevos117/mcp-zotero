import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { resolveDois } from "../utils/doi-resolver.js";
import { cslToZoteroItem } from "../utils/csl-to-zotero.js";
import { logger } from "../utils/logger.js";
import { postInBatches } from "../utils/write-results.js";
import { OaPdfResult, attachOpenAccessPdfs } from "../utils/oa-pdf.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "add_items_by_doi",
  description: `Add items to your Zotero library by resolving DOIs. Works with ANY item type that has a DOI — journal articles, books, datasets, preprints, conference papers, reports, etc. For each DOI, resolves metadata via content negotiation and creates the item in Zotero with the correct type automatically. Returns a list of successfully added items (with item_key and title) and any failures.

WHEN TO USE vs add_items:
- Use add_items_by_doi when the item HAS a DOI — it auto-resolves all metadata and attaches OA PDFs.
- Use add_items when the item does NOT have a DOI, or when you need to override specific metadata fields (add_items_by_doi does not allow metadata overrides).
- Mixed batch: if some items have DOIs and others don't, make two separate calls — add_items_by_doi for the DOIs and add_items for the rest.

WORKFLOW TIPS:
- To collect metadata for all added items, call get_items_details with the returned item_keys (single batch call).
- To create a cited Word document, use the returned item_keys as <zcite keys="ITEMKEY"/> placeholders in a .docx, then call inject_citations. See inject_citations description for the full workflow.`,
  inputSchema: {
    dois: z
      .array(z.string())
      .describe(
        'Array of DOI strings (e.g. ["10.1038/s41586-023-06647-8"]). Each DOI will be resolved and added to Zotero.'
      ),
    collection_key: z
      .string()
      .optional()
      .describe(
        "Zotero collection key to add items to. Get this from create_collection or get_collections."
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe("Tags to apply to all added items"),
    auto_attach_pdf: z
      .boolean()
      .default(true)
      .describe(
        "Attach freely available OA PDFs via Unpaywall (default: true). This is lightweight and adds no cost — leave enabled. Only set to false if PDF attachment is causing errors."
      ),
    ...libraryArgsSchema,
  },
} as const;

const AddItemsByDoiSchema = z.object(toolConfig.inputSchema);

/**
 * Shared pipeline result, plus the fields earlier versions returned: `pdf_attached`, `pdf_url`
 * (attached URL) and `error` (reason when nothing was attached).
 */
type PdfAttachResult = OaPdfResult & { pdf_attached: boolean; pdf_url?: string; error?: string };

export async function handleAddItemsByDoi(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { dois, collection_key, tags, auto_attach_pdf, library_type, library_id } = AddItemsByDoiSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  if (dois.length === 0) {
    return formatErrorResponse("At least one DOI is required");
  }

  try {
    const resolved = await resolveDois(dois);

    if (resolved.success.length === 0) {
      return formatErrorResponse("All DOI resolutions failed", {
        failed: resolved.failed,
      });
    }

    const zoteroItems = resolved.success.map((r) =>
      cslToZoteroItem(r.data, {
        collectionKey: collection_key,
        tags,
      })
    );

    const write = await postInBatches(
      (batch) => zoteroApi.library(libraryType, libraryId).items().post(batch),
      zoteroItems
    );
    // Report resolution and write failures together, so a partial write never hides created items
    const failed = [
      ...resolved.failed,
      ...write.failed.map(({ index, error }) => ({ doi: resolved.success[index].doi, error })),
    ];

    if (write.created.length === 0) {
      const errorMessages = write.failed.map(({ index, error }) => `Item ${index}: ${error}`).join("; ");
      return formatErrorResponse(`Zotero API write failed: ${errorMessages}`, { failed });
    }

    const success = write.created.map(({ index, entity }) => {
      const { doi, data } = resolved.success[index];
      return { doi, item_key: entity.key as string, title: entity.title ?? data.title ?? "Untitled" };
    });

    let pdf_results: PdfAttachResult[] | undefined;
    const apiKey = process.env.ZOTERO_API_KEY;
    if (auto_attach_pdf && apiKey) {
      const targets = success.filter((s) => s.doi).map((s) => ({ itemKey: s.item_key, doi: s.doi }));
      const results = await attachOpenAccessPdfs(targets, {
        zoteroApi,
        library: { type: libraryType, id: libraryId },
        apiKey,
      });
      pdf_results = results.map((r) =>
        r.status === "attached"
          ? { ...r, pdf_attached: true, pdf_url: r.url_used }
          : { ...r, pdf_attached: false, error: r.reason }
      );
    }

    const quotaHit = pdf_results?.some((r) => r.status === "quota_exceeded");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success,
              failed,
              ...(pdf_results !== undefined ? { pdf_results } : {}),
              ...(quotaHit
                ? {
                    storage_quota_warning:
                      "Zotero storage quota is full. Some PDF attachments were skipped. All items were created successfully (metadata only). Free up space at https://www.zotero.org/settings/storage or upgrade your plan.",
                  }
                : {}),
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
        tool: "add_items_by_doi",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}
