import { z } from "zod";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { formatJsonResult, formatErrorResponse } from "../utils/error-formatter.js";
import { createCitedDocument } from "../cited-document/create.js";
import { resolveLibrary, libraryArgsSchema } from "../utils/library-context.js";

export const toolConfig = {
  name: "create_cited_document",
  description: `Create a Word (.docx) or LibreOffice (.odt) document from Markdown with native Zotero citations and a bibliography, ready for the Zotero plugin's Refresh. Unlike inject_citations (which fills <zcite> placeholders in an existing file), this writes a new document from Markdown text.

WORKFLOW:
1. Collect item keys with add_items_by_doi, add_items or search_library.
2. Write the body as Markdown, with pandoc-style citations where they belong.
3. Call this tool with the Markdown and an output path. It fetches metadata from Zotero, renders the document and appends the bibliography. It never overwrites an existing file.
4. Tell the user to open it in Word or LibreOffice with the Zotero plugin → Add/Edit Bibliography, then Refresh.

MARKDOWN SUBSET: headings (#…), paragraphs, bold (**…**), italic (*…*), one-level bullet lists (-). Anything else is kept as text, with a warning.

CITATIONS (pandoc style): [@KEY] one item; [@KEY1; @KEY2] several; [see @KEY, p. 12] with prefix and locator; -@KEY to suppress the author. KEY is a Zotero item key. For IEEE/Vancouver the numbers follow the order of first citation automatically.

OUTPUT: a new .docx or .odt (format from the extension, or the format argument). A cited key that is not in the library, or is not a Zotero key, is an error and nothing is written. If the output file already exists it is an error (never overwritten).`,
  inputSchema: {
    markdown: z.string().describe("The document body as Markdown, with pandoc-style citations like [@ITEMKEY]."),
    output_path: z
      .string()
      .describe("Absolute path of the .docx or .odt file to create. Must not already exist."),
    style: z
      .enum(["apa", "ieee", "vancouver", "harvard", "chicago"])
      .optional()
      .default("apa")
      .describe("Citation style for the visible placeholder text. Zotero reformats on refresh. Default: apa"),
    format: z
      .enum(["docx", "odt"])
      .optional()
      .describe("docx for Word, odt for LibreOffice. Defaults to the output extension; an error if it disagrees."),
    ...libraryArgsSchema,
  },
} as const;

const Schema = z.object(toolConfig.inputSchema);

export async function handleCreateCitedDocument(
  zoteroApi: ZoteroApiInterface,
  userId: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { markdown, output_path, style, format, library_type, library_id } = Schema.parse(args);
  const { type: libraryType, id: libraryId } = resolveLibrary({ library_type, library_id }, userId);

  const extFormat = output_path.endsWith(".docx") ? "docx" : output_path.endsWith(".odt") ? "odt" : undefined;
  if (!extFormat) {
    return formatErrorResponse("Output must be a .docx (Word) or .odt (LibreOffice) file", {
      output_path,
      hint: "The output name must end in lowercase .docx or .odt.",
    });
  }
  if (format && format !== extFormat) {
    return formatErrorResponse(`format '${format}' does not match the output extension of ${output_path}`, {
      output_path,
      hint: `The file ends in .${extFormat}: pass format "${extFormat}" or omit it.`,
    });
  }

  let result: Awaited<ReturnType<typeof createCitedDocument>>;
  try {
    result = await createCitedDocument(markdown, output_path, zoteroApi, libraryType, libraryId, style, format ?? extFormat);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return formatErrorResponse("The output file already exists; it was not overwritten.", {
        output_path,
        hint: "Choose a different output_path, or delete/rename the existing file and call again.",
      });
    }
    if (code === "EBUSY") {
      return formatErrorResponse("Cannot write the document: the output file is locked (EBUSY).", {
        output_path,
        hint: "Close the file if it is open in Word or LibreOffice and call again.",
      });
    }
    if (code === "ENOENT") {
      return formatErrorResponse("Cannot write the document: the output folder does not exist.", {
        output_path,
        hint: "Create the folder or pass an output_path in an existing folder.",
      });
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      return formatErrorResponse(`Cannot write the document (${code}).`, {
        output_path,
        hint: "Pass an output_path in a folder this server can write to.",
      });
    }
    throw err;
  }

  const responseObj: Record<string, unknown> = {
    output_path: result.outputPath,
    blocks: result.blocks,
    citations: result.citations,
  };
  if (result.warnings.length > 0) responseObj.warnings = result.warnings;
  return formatJsonResult(responseObj);
}
