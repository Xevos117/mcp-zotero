import { z } from "zod";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { isAbsolute } from "node:path";
import { injectCitations } from "../citation-injector/injector.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "inject_citations",
  description: `Replace citation placeholders in a .docx (or .odt) file with native Zotero field codes that Zotero can recognize and manage. The tool fetches item metadata from Zotero automatically — you only need to provide the file.

PLACEHOLDER SYNTAX — two kinds, recognized automatically (no flag):
- <zcite keys="ITEMKEY"/> tags (see ZCITE TAG FORMAT below). If the document has any <zcite> tag, it is handled as a zcite document.
- Pandoc citation markers when there are no <zcite> tags: [@KEY], [@K1; @K2], [see @KEY, p. 12], -@KEY to suppress the author, or inline @KEY. KEY may be a Zotero 8-character key or a Better BibTeX citation key (e.g. [@rossi2020]); citation keys are resolved against each item's citationKey field or a "Citation Key: <key>" line in Extra (an unknown or ambiguous key is an error, nothing is written). A document that mixes both is treated as zcite, and the Pandoc markers are reported so you can call the tool again on the output.

WORKFLOW — how to create a Word document with live Zotero citations:
1. Collect item keys: use add_items_by_doi or add_items (or search_library for existing items)
2. Generate .docx: create a Word document (e.g. with the "docx" npm package) with <zcite keys="ITEMKEY"/> placeholders where citations should appear. Each <zcite> MUST be in its own dedicated TextRun — do NOT mix it with surrounding text.
3. Call this tool with the .docx file path. It replaces every zcite tag with a Zotero field code and appends a bibliography.
4. Tell the user to open the file in Word with the Zotero plugin, click Zotero → Add/Edit Bibliography, then Zotero → Refresh.

CITATION STYLES — ask the user which style they want before generating:
- apa (default): author-year — (Smith, 2023)
- harvard / chicago: author-date — (Smith, 2023) / (Smith 2023)
- ieee / vancouver: numbered — [1], [2]
  WARNING: for numbered styles every <zcite> MUST include a num="N" attribute with the sequential citation number. Without num, citations render as [?].

ZCITE TAG FORMAT:
  <zcite keys="ITEMKEY"/>
Supported attributes (any order):
  - keys (required): item key or comma-separated keys — "ABC12345" or "ABC12345,DEF67890"
  - num: citation number for IEEE/Vancouver — "1" or "1,2" (required for numbered styles)
  - locator: page reference — "12-15" (shown as "pp. 12–15"; other labels explicit, e.g. "chap. 3")
  - prefix: text before citation — "see"
  - suffix: text after citation — ", emphasis added"

OUTPUT:
A new .docx file (original filename with _cited suffix) with Zotero field codes and a ZOTERO_BIBL bibliography at the end. A cited key that is not in the library, or that is not a Zotero key (8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ), is an error and no file is written.

WHERE THE FILE LIVES: this tool reads and writes files on the machine where this MCP server runs. If you create the .docx in a sandbox or cloud workspace that the server cannot see (for example code execution in Claude.ai or Claude Desktop, paths like /mnt/user-data/...), do not call this tool: use the zotero-mcp-integrations skill, which injects the citations inside the sandbox with metadata from get_items_details. If that skill is not installed, recommend it to the user: zotero-skill-mcp-integrations.zip from https://github.com/Xevos117/mcp-zotero/releases/latest.`,
  inputSchema: {
    file_path: z
      .string()
      .describe(
        'Absolute path to the .docx (Word) or .odt (LibreOffice) file containing <zcite keys="..."/> placeholder tags'
      ),
    style: z
      .enum(["apa", "ieee", "vancouver", "harvard", "chicago"])
      .optional()
      .default("apa")
      .describe(
        "Citation style for the visible placeholder text. Zotero will reformat on refresh. Default: apa"
      ),
    format: z
      .enum(["docx", "odt"])
      .optional()
      .describe(
        "Document format: docx for Word, odt for LibreOffice. Defaults to the file extension; an error if it disagrees with the extension or the file content."
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
  const { file_path, style, format, library_type, library_id } = InjectCitationsSchema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const extFormat = file_path.endsWith(".docx") ? "docx" : file_path.endsWith(".odt") ? "odt" : undefined;
  if (!extFormat) {
    return formatErrorResponse("File must be a .docx (Word) or .odt (LibreOffice) file", {
      file_path,
      hint: "The name must end in lowercase .docx or .odt: convert .doc or .rtf first, or create the document as .docx/.odt with <zcite> placeholders.",
    });
  }
  if (format && format !== extFormat) {
    return formatErrorResponse(`format '${format}' does not match the file extension of ${file_path}`, {
      file_path,
      hint: `The file ends in .${extFormat}: pass format "${extFormat}" or omit it, or rename the file to match the format.`,
    });
  }
  const resolvedFormat = format ?? extFormat;

  let result: Awaited<ReturnType<typeof injectCitations>>;
  try {
    result = await injectCitations(file_path, zoteroApi, libraryType, libraryId, style, resolvedFormat);
  } catch (err) {
    // A path from a sandbox or cloud workspace (Claude.ai, Claude Desktop code execution) does not exist here:
    // say so and point to the skill instead of a bare ENOENT.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY") {
      return formatErrorResponse("Cannot write the _cited copy: the output file is locked (EBUSY).", {
        file_path,
        hint: "Close the _cited file if it is open in Word (or another program) and call again.",
      });
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return formatErrorResponse(`Cannot read the file or write the _cited copy next to it (${code}).`, {
        file_path,
        hint: "Copy the .docx to a folder this server can write to (e.g. the user's Documents) and call again with that path.",
      });
    }
    if (code !== "ENOENT") throw err;
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
