import { z, ZodRawShape } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP prompts: reusable, user-initiated starting points that spell out a Zotero workflow in terms of the
 * tools this server exposes. The text is in English, like the tool descriptions. Each prompt renders to a
 * single user message; manifest.json mirrors the same text with ${arguments.x} placeholders (kept in sync
 * by a test), so a prompt is defined once here.
 */

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape; keys are the (string) argument names, in the order the manifest lists them. */
  argsSchema: ZodRawShape;
  /** The user-message text for the given argument values. */
  template(args: Record<string, string | undefined>): string;
}

const STYLES = "apa, chicago, harvard, ieee or vancouver";

export const PROMPTS: PromptDef[] = [
  {
    name: "cite_word_document",
    title: "Add Zotero citations to a Word document",
    description:
      "Turn the <zcite> placeholders in an existing .docx (or .odt) into live Zotero citations and a bibliography.",
    argsSchema: {
      file_path: z
        .string()
        .describe("Absolute path to the .docx/.odt file on the machine running this server"),
      style: z
        .string()
        .optional()
        .describe(`Citation style: ${STYLES} (default apa)`),
    },
    template: (a) =>
      [
        `I have a Word document at ${a.file_path} and I want to add Zotero citations to it.`,
        "",
        "Please:",
        "1. Make sure each place a citation should appear contains a <zcite keys=\"ITEMKEY\"/> placeholder in its own text run (keys are Zotero item keys from search_library, add_items or add_items_by_doi). For a numbered style (ieee/vancouver) every <zcite> also needs a num attribute, numbered in order of first appearance.",
        `2. Call inject_citations with file_path "${a.file_path}" and style "${a.style ?? "apa"}". It fetches the metadata from Zotero and writes a new <name>_cited file next to the original.`,
        "3. Tell me to open the result in Word with the Zotero plugin and run Zotero → Refresh, so the citations become editable.",
      ].join("\n"),
  },
  {
    name: "write_cited_document",
    title: "Write a cited document from scratch",
    description:
      "Draft a document on a topic with inline Zotero citations and a bibliography, saved as .docx or .odt.",
    argsSchema: {
      topic: z.string().describe("What the document should be about"),
      output_path: z
        .string()
        .describe("Absolute path where the finished document is written"),
      format: z
        .string()
        .optional()
        .describe("Output format: docx or odt (default docx)"),
      style: z
        .string()
        .optional()
        .describe(`Citation style: ${STYLES} (default apa)`),
    },
    template: (a) =>
      [
        `Write a well-structured document about "${a.topic}" with Zotero citations, and save it to ${a.output_path} as ${a.format ?? "docx"}.`,
        "",
        "Please:",
        "1. Gather the references in Zotero first: add_items_by_doi for items with a DOI, add_items for the rest, or search_library to reuse items already in the library. Keep track of each item key.",
        "2. Write the body as Markdown and cite sources inline with pandoc-style keys: [@ITEMKEY] for one source, [@KEY1; @KEY2] for several, [see @ITEMKEY, p. 12] with a locator, and -@ITEMKEY to suppress the author.",
        `3. Call create_cited_document with that Markdown as the markdown argument, output_path "${a.output_path}", format "${a.format ?? "docx"}" and style "${a.style ?? "apa"}". It resolves the citations against Zotero, numbers them in order of first appearance and appends the bibliography.`,
        "4. Tell me the citations are live Zotero fields: open the result in Word or LibreOffice with the Zotero plugin and run Refresh to edit them.",
      ].join("\n"),
  },
  {
    name: "import_references",
    title: "Import references by DOI",
    description: "Add one or more references to Zotero from their DOIs, attaching open-access PDFs when available.",
    argsSchema: {
      dois: z
        .string()
        .describe("The DOIs to import, separated by commas or newlines"),
    },
    template: (a) =>
      [
        `Import these references into Zotero by DOI: ${a.dois}`,
        "",
        "Please:",
        "1. Call find_duplicates with these DOIs (strip any surrounding text, keep only the bare DOIs) to see which are already in the library.",
        "2. Call add_items_by_doi with the DOIs that are not already present. It resolves the metadata automatically and attaches an open-access PDF when one is found.",
        "3. Call check_retractions with item_keys set to the keys of the items just added, to flag anything retracted or under an expression of concern (if the response has truncated: true, call again with start = next_start).",
        "4. For any imported item still without a PDF, try find_and_attach_pdfs.",
        "Report which DOIs were added, which were skipped as already present and which failed, and any retraction warnings; suggest add_items for anything without a usable DOI.",
      ].join("\n"),
  },
  {
    name: "note_from_item",
    title: "Summarize an item as a note",
    description: "Read an existing Zotero item and attach a concise summary as a child note.",
    argsSchema: {
      item_key: z.string().describe("The Zotero item key to summarize"),
    },
    template: (a) =>
      [
        `Read the Zotero item ${a.item_key} and attach a short summary note to it.`,
        "",
        "Please:",
        `1. Fetch the item with get_items_details (item_keys ["${a.item_key}"], include_abstract true); if it has a PDF, get_item_fulltext for more detail.`,
        `2. Write a concise plain-text summary (key points, method, findings) and attach it with create_note (parent_item_key "${a.item_key}"). Use blank lines between paragraphs; no HTML or Markdown.`,
      ].join("\n"),
  },
  {
    name: "check_bibliography",
    title: "Check a collection before handing it in",
    description: "Check a Zotero collection for retracted items and duplicates before using it in a document.",
    argsSchema: {
      collection_key: z.string().describe("The Zotero collection key to check (from get_collections)"),
    },
    template: (a) =>
      [
        `Check the Zotero collection ${a.collection_key} before I use it in a bibliography.`,
        "",
        "Please:",
        `1. Call find_duplicates with collection_key "${a.collection_key}" to list duplicate items (same DOI or normalized title). Report each group and suggest which to keep; do not delete anything without asking.`,
        `2. Call check_retractions with collection_key "${a.collection_key}" to flag any retracted items or expressions of concern (if the response has truncated: true, continue with start = next_start).`,
        "3. Summarize what you found and what I should fix before handing the bibliography in.",
      ].join("\n"),
  },
];

/** Register every prompt on the server (call once, before connect, with the prompts capability declared). */
export function registerAllPrompts(server: McpServer): void {
  for (const p of PROMPTS) {
    server.registerPrompt(
      p.name,
      { title: p.title, description: p.description, argsSchema: p.argsSchema },
      (args) => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: p.template(args as Record<string, string | undefined>) },
          },
        ],
      })
    );
  }
}

/** The argument names of a prompt, in manifest order. */
export function promptArgumentNames(p: PromptDef): string[] {
  return Object.keys(p.argsSchema);
}

/** The prompt text with every argument left as a ${arguments.x} placeholder, as manifest.json stores it. */
export function promptManifestText(p: PromptDef): string {
  const placeholders = Object.fromEntries(
    promptArgumentNames(p).map((k) => [k, "${arguments." + k + "}"])
  );
  return p.template(placeholders);
}
