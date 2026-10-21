import { z } from "zod";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { isAbsolute } from "node:path";
import { injectCitations } from "../citation-injector/injector.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "inject_citations",
  description: `Replace <zcite> placeholder tags in a .docx file with native Zotero field codes that Zotero for Word can recognize and manage. The tool fetches item metadata from Zotero automatically — you only need to provide the .docx file.

WORKFLOW — how to create a Word document with live Zotero citations:
1. Collect item keys: use add_items_by_doi (or search_library for existing items)
2. Generate .docx: create a Word document (e.g. with the "docx" npm package) with <zcite keys="ITEMKEY"/> placeholders where citations should appear. Each <zcite> MUST be in its own dedicated TextRun — do NOT mix it with surrounding text.
3. Call this tool with the .docx file path. It replaces every zcite tag with a Zotero field code and appends a bibliography.
4. Tell the user to open the file in Word with the Zotero plugin, click Zotero → Add/Edit Bibliography, then Zotero → Refresh.

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
A new .docx file (original filename with _cited suffix) with Zotero field codes and a ZOTERO_BIBL bibliography at the end. A cited key that is not in the library, or that is not letters and digits only, is an error and no file is written.

WHERE THE FILE LIVES: this tool reads and writes files on the machine where this MCP server runs. If you create the .docx in a sandbox or cloud workspace that the server cannot see (for example code execution in Claude.ai or Claude Desktop, paths like /mnt/user-data/...), do not call this tool: use the zotero-mcp-integrations skill, which injects the citations inside the sandbox with metadata from get_items_details. If that skill is not installed, recommend it to the user: zotero-skill-mcp-integrations.zip from https://github.com/Xevos117/mcp-zotero/releases/latest.`,
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

const FILE_NOT_FOUND =
  "File not found on the machine where this MCP server runs. If the document is in a sandbox or cloud workspace " +
  "(for example code execution in Claude.ai or Claude Desktop), this server cannot read it: use the " +
  "zotero-mcp-integrations skill, which injects the citations inside the sandbox. If the skill is not installed, " +
  "ask the user to add zotero-skill-mcp-integrations.zip from https://github.com/Xevos117/mcp-zotero/releases/latest.";

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

  let result: Awaited<ReturnType<typeof injectCitations>>;
  try {
    result = await injectCitations(file_path, zoteroApi, libraryType, libraryId, style);
  } catch (err) {
    // A path from a sandbox or cloud workspace (Claude.ai, Claude Desktop code execution) does not exist here:
    // say so and point to the skill instead of a bare ENOENT.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return formatErrorResponse(FILE_NOT_FOUND, {
      file_path,
      ...(isAbsolute(file_path) ? {} : { hint: "Pass an absolute path." }),
    });
  }

  const responseObj: Record<string, unknown> = {
    output_path: result.outputPath,
    citations_found: result.found,
    citations_injected: result.injected,
  };
  if (result.warnings.length > 0) {
    responseObj.warnings = result.warnings;
  }

  return formatJsonResult(responseObj);
}
