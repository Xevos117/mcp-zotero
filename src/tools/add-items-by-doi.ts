import { z } from "zod";
import { zoteroKey } from "../utils/zotero-keys.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { resolveDois } from "../utils/doi-resolver.js";
import { cslToZoteroItem } from "../utils/csl-to-zotero.js";
import { postInBatches } from "../utils/write-results.js";
import { OaPdfResult, attachOpenAccessPdfs } from "../utils/oa-pdf.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";
import { UNPAYWALL_EMAIL_HINT, UNPAYWALL_EMAIL_MISSING } from "../utils/unpaywall.js";

export const toolConfig = {
  name: "add_items_by_doi",
  description: `Add items to your Zotero library by resolving DOIs. Works with ANY item type that has a DOI — journal articles, books, datasets, preprints, conference papers, reports, etc. For each DOI, resolves metadata via content negotiation and creates the item in Zotero with the correct type automatically. Returns a list of successfully added items (with item_key and title) and any failures.

WHEN TO USE vs add_items:
- Use add_items_by_doi when the item HAS a DOI — it auto-resolves all metadata and attaches open-access PDFs (when the server has UNPAYWALL_EMAIL set).
- Use add_items when the item does NOT have a DOI, or when you need to override specific metadata fields (add_items_by_doi does not allow metadata overrides).
- Mixed batch: if some items have DOIs and others don't, make two separate calls — add_items_by_doi for the DOIs and add_items for the rest.

WORKFLOW TIPS:
- To collect metadata for all added items, call get_items_details with the returned item_keys (single batch call).
- To create a cited Word document, use the returned item_keys as <zcite keys="ITEMKEY"/> placeholders in a .docx, then call inject_citations. See inject_citations description for the full workflow.`,
  inputSchema: {
    dois: z
      .array(z.string().trim().min(1, "DOI must not be empty"))
      .describe(
        'Array of bare DOIs (e.g. ["10.1038/s41586-023-06647-8"], without "https://doi.org/"). Each DOI will be resolved and added to Zotero.'
      ),
    collection_key: zoteroKey()
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
        "Attach open-access PDFs found via Unpaywall (default: true; needs UNPAYWALL_EMAIL in the server settings, uses the user's Zotero file storage). Leave enabled unless the user does not want PDFs or attachment is causing errors."
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
    return formatErrorResponse('At least one DOI is required: pass dois as an array, e.g. ["10.1038/s41586-023-06647-8"].');
  }

  const resolved = await resolveDois(dois);

  if (resolved.success.length === 0) {
    return formatErrorResponse("All DOI resolutions failed", {
      failed: resolved.failed,
      hint:
        "Nothing was created; failed[].error gives the reason per DOI. Pass bare DOIs (10.xxxx/...) and check them for typos. " +
        "For a DOI that does not resolve, add the item with add_items and its metadata instead. If every DOI failed with a timeout, network or 5xx error, retry later.",
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
    return formatErrorResponse(`Zotero API write failed: ${errorMessages}`, {
      failed,
      hint: "Nothing was created. Fix what failed[].error reports (an invalid collection_key: check it with get_collections) and retry; for a rate limit or server error, wait a minute and retry once.",
    });
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
  const unpaywallOff = pdf_results?.some((r) => r.reason === UNPAYWALL_EMAIL_MISSING);

  return formatJsonResult({
    success,
    failed,
    ...(pdf_results !== undefined ? { pdf_results } : {}),
    ...(quotaHit
      ? {
          storage_quota_warning:
            "Zotero storage quota is full. Some PDF attachments were skipped. All items were created successfully (metadata only). Tell the user they can free up space or upgrade at https://www.zotero.org/settings/storage, then attach the PDFs with find_and_attach_pdfs.",
        }
      : {}),
    ...(unpaywallOff ? { hint: UNPAYWALL_EMAIL_HINT } : {}),
  });
}
