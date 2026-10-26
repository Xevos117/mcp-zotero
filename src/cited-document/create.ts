import { ZoteroApiInterface } from "../types/zotero-types.js";
import { LibraryType } from "../utils/library-context.js";
import { DocumentFormat, CitationRequest } from "../citation-injector/model.js";
import { resolveCitations } from "../citation-injector/pipeline.js";
import { zoteroItemSource } from "../citation-injector/injector.js";
import { FormatWriter } from "../citation-injector/formats/types.js";
import { docxWriter } from "../citation-injector/formats/docx.js";
import { odtWriter } from "../citation-injector/formats/odt.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { parseMarkdown } from "./markdown.js";
import { assignNumbers } from "./number.js";
import { ResolvedBlock, ResolvedInline } from "./model.js";
import { buildCitedDocument } from "./document.js";

const WRITERS: Record<DocumentFormat, FormatWriter> = { docx: docxWriter, odt: odtWriter };

export interface CreateResult {
  outputPath: string;
  blocks: number;
  citations: number;
  warnings: string[];
}

/**
 * Crea un documento (.docx o .odt) da markdown con citazioni Zotero native. Riusa resolveCitations (stessi
 * controlli ed errori di inject_citations), lo scheletro dello scrittore, le preferenze e la bibliografia.
 * Non sovrascrive mai un file esistente (writeFileAtomic overwrite:false → EEXIST).
 */
export async function createCitedDocument(
  markdown: string,
  outputPath: string,
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  userId: string,
  style: string,
  format: DocumentFormat
): Promise<CreateResult> {
  const { blocks, warnings } = parseMarkdown(markdown);

  // richieste di citazione in ordine di documento
  const requests: CitationRequest[] = [];
  for (const b of blocks) for (const i of b.inlines) if (i.kind === "cite") requests.push(i.request);

  // numerazione per gli stili numerici
  if (style === "ieee" || style === "vancouver") {
    const nums = assignNumbers(requests);
    for (const r of requests) r.num = nums.get(r);
  }

  const prepared = await resolveCitations(requests, zoteroItemSource(zoteroApi, libraryType, userId), { libraryType, userId, style });
  const byRequest = new Map(prepared.map((p) => [p.request, p]));

  const resolvedBlocks: ResolvedBlock[] = blocks.map((b) => ({
    type: b.type,
    level: b.level,
    inlines: b.inlines.map((i): ResolvedInline => (i.kind === "cite" ? { kind: "cite", prepared: byRequest.get(i.request)! } : i)),
  }));

  const writer = WRITERS[format] ?? docxWriter;
  const { buffer, warnings: buildWarnings } = await buildCitedDocument(writer, resolvedBlocks, style, requests.length > 0);
  await writeFileAtomic(outputPath, buffer, { overwrite: false });

  return { outputPath, blocks: blocks.length, citations: requests.length, warnings: [...warnings, ...buildWarnings] };
}
