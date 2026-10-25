import { escapeXml } from "../citation-injector/xml-utils.js";
import { FormatWriter } from "../citation-injector/formats/types.js";
import { ResolvedBlock, ResolvedInline } from "./model.js";

/**
 * Costruisce il corpo del documento (da zero) a partire dai blocchi del markdown, inserendo le citazioni
 * native con lo scrittore di formato. Grassetto/corsivo in linea, titoli, elenchi a un livello (resi come
 * paragrafi con un punto elenco, per restare un pacchetto valido senza numbering/stili aggiuntivi).
 */

// ─── docx ───────────────────────────────────────────────────────

const HEADING_SZ: Record<number, number> = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 22 }; // half-points

function docxRun(text: string, { bold, italic, headingLevel }: { bold?: boolean; italic?: boolean; headingLevel?: number }): string {
  const props: string[] = [];
  if (bold || headingLevel) props.push("<w:b/>");
  if (italic) props.push("<w:i/>");
  if (headingLevel) props.push(`<w:sz w:val="${HEADING_SZ[headingLevel] ?? 22}"/>`);
  const rPr = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function docxInlines(inlines: ResolvedInline[], writer: FormatWriter, headingLevel?: number): string {
  return inlines.map((i) => (i.kind === "text" ? docxRun(i.text, { bold: i.bold, italic: i.italic, headingLevel }) : writer.citationXml(i.prepared))).join("");
}

export function renderDocxBlocks(blocks: ResolvedBlock[], writer: FormatWriter): string {
  return blocks
    .map((b) => {
      if (b.type === "heading") return `<w:p>${docxInlines(b.inlines, writer, b.level ?? 1)}</w:p>`;
      if (b.type === "list-item") return `<w:p>${docxRun("•\t", {})}${docxInlines(b.inlines, writer)}</w:p>`;
      return `<w:p>${docxInlines(b.inlines, writer)}</w:p>`;
    })
    .join("");
}

// ─── odt ────────────────────────────────────────────────────────

function odtInline(i: ResolvedInline, writer: FormatWriter): string {
  if (i.kind === "cite") return writer.citationXml(i.prepared);
  const style = i.bold ? ' text:style-name="T_Bold"' : i.italic ? ' text:style-name="T_Italic"' : "";
  return `<text:span${style}>${escapeXml(i.text)}</text:span>`;
}

export function renderOdtBlocks(blocks: ResolvedBlock[], writer: FormatWriter): string {
  return blocks
    .map((b) => {
      const inner = b.inlines.map((i) => odtInline(i, writer)).join("");
      if (b.type === "heading") return `<text:h text:outline-level="${b.level ?? 1}">${inner}</text:h>`;
      if (b.type === "list-item") return `<text:p>• ${inner}</text:p>`;
      return `<text:p>${inner}</text:p>`;
    })
    .join("");
}

/**
 * Assembla il documento: scheletro dello scrittore, corpo dai blocchi, bibliografia (solo se ci sono
 * citazioni) e preferenze del documento. Non scrive su disco. `hasCitations` decide bibliografia/preferenze.
 */
export async function buildCitedDocument(
  writer: FormatWriter,
  blocks: ResolvedBlock[],
  style: string,
  hasCitations: boolean
): Promise<{ buffer: Buffer; warnings: string[] }> {
  if (!writer.skeleton) throw new Error(`format ${writer.format} has no skeleton`);
  const zip = await writer.skeleton();
  const rendered = writer.format === "odt" ? renderOdtBlocks(blocks, writer) : renderDocxBlocks(blocks, writer);

  let body = await zip.file(writer.bodyPart)!.async("string");
  if (writer.format === "odt") {
    body = body.replace("</office:text>", `${rendered}</office:text>`);
  } else {
    body = body.includes("<w:sectPr") ? body.replace("<w:sectPr", `${rendered}<w:sectPr`) : body.replace("</w:body>", `${rendered}</w:body>`);
  }

  const warnings: string[] = [];
  if (hasCitations) {
    body = writer.appendBibliography(body);
    zip.file(writer.bodyPart, body);
    const prefs = await writer.writePrefs(zip, style);
    warnings.push(...writer.prefsWarnings(prefs));
  } else {
    zip.file(writer.bodyPart, body);
  }

  if (writer.finalize) await writer.finalize(zip);
  const buffer = (await zip.generateAsync({ type: "nodebuffer", ...writer.generateOptions })) as Buffer;
  return { buffer, warnings };
}
