import { z } from "zod";
import { ZoteroApiInterface, isZoteroApiError } from "../types/zotero-types.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import { injectCitations } from "../citation-injector/injector.js";
import { logger } from "../utils/logger.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "inject_citations",
  description: `Replace <zcite> placeholder tags in a .docx file with native Zotero field codes that Zotero for Word can recognize and manage. The tool fetches item metadata from Zotero automatically — you only need to provide the .docx file.

WORKFLOW — how to create a Word document with live Zotero citations:
1. Collect item keys: use add_items_by_doi (or search_library for existing items)
2. Generate .docx: create a Word document (e.g. with the "docx" npm package) with <zcite keys="ITEMKEY"/> placeholders where citations should appear. Each <zcite> MUST be in its own dedicated TextRun — do NOT mix it with surrounding text.
3. Call this tool with the .docx file path. It replaces every zcite tag with a Zotero field code and appends a bibliography.
4. Tell the user to open the file in Word with the Zotero plugin and click Zotero → Refresh.

CITATION STYLES — ask the user which style they want before generating:
- apa (default): author-year — (Smith, 2023)
- ieee / vancouver: numbered — [1], [2]
  WARNING: for numbered styles every <zcite> MUST include a num="N" attribute with the sequential citation number. Without num, citations render as [?].

ZCITE TAG FORMAT:
  <zcite keys="ITEMKEY"/>
Supported attributes (any order):
  - keys (required): item key or comma-separated keys — "ABC12345" or "ABC12345,DEF67890"
  - num: citation number for IEEE/Vancouver — "1" or "1,2" (required for numbered styles)
  - locator: page reference — "pp. 12-15"
  - prefix: text before citation — "see "
  - suffix: text after citation — ", emphasis added"

OUTPUT:
A new .docx file (original filename with _cited suffix) with Zotero field codes and a ZOTERO_BIBL bibliography at the end.

NOTE: If the inject-citations skill is available, prefer the skill workflow (runs in sandbox, no filesystem dependency). This tool serves as the primary path when the skill is not available.`,
  inputSchema: {
    file_path: z
      .string()
      .describe(
        'Absolute path to the .docx file containing <zcite keys="..."/> placeholder tags'
      ),
    style: z
      .enum(["apa", "ieee", "vancouver", "harvard", "chicago"])
      .optional()
      .default("apa")
      .describe(
        "Citation style for the visible placeholder text. Zotero will reformat on refresh. Default: apa"
      ),
    ...libraryArgsSchema,
  },
} as const;

const InjectCitationsSchema = z.object(toolConfig.inputSchema);

export async function handleInjectCitations(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { file_path, style, library_type, library_id } = InjectCitationsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  if (!file_path.endsWith(".docx")) {
    return formatErrorResponse("File must be a .docx file", {
      file_path,
    });
  }

  try {
    const result = await injectCitations(file_path, zoteroApi, libraryType, libraryId, style);

    const responseObj: Record<string, unknown> = {
      output_path: result.outputPath,
      citations_found: result.found,
      citations_injected: result.injected,
    };
    if (result.warnings.length > 0) {
      responseObj.warnings = result.warnings;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(responseObj, null, 2),
        },
      ],
    };
  } catch (err) {
    if (isZoteroApiError(err)) {
      logger.error("Tool execution failed", {
        tool: "inject_citations",
        status: err.response?.status,
        errorMessage: err.message,
        url: err.response?.url,
      });
    }
    throw err;
  }
}
