import JSZip from "jszip";
import { FormatWriter } from "./types.js";
import { InjectionError, PreparedCitation } from "../model.js";
import { regexEscape } from "../xml-utils.js";
import { normalizeZciteTags } from "../zcite-normalizer.js";
import { generateZoteroFieldCode, generateBibliographyFieldCode } from "../field-codes.js";
import {
  DocumentPrefsOutcome,
  EXISTING_PREFS_WARNING,
  PREFS_NOT_WRITTEN_WARNING,
  writeZoteroDocumentPrefs,
} from "../document-prefs.js";

const REGENERATE_DOCX =
  "The file is not a Word document or is corrupted: create it again as .docx (e.g. with the docx npm package) and call again.";

/**
 * Sostituisce il tag <zcite> (escapato) con il field code Word. Caso A (il tag è l'unico contenuto di un
 * <w:r>), caso B (il tag è inline con altro testo). La `<w:r>` iniziale può avere attributi
 * (`<w:r w:rsidR="…">`, scritti da Word quando tiene traccia delle revisioni): `<w:r[^>]*>` li tollera.
 * Prima venivano saltati in silenzio (found ma non injected); i documenti senza attributi non cambiano.
 */
function replaceZciteInXml(xml: string, escapedZciteTag: string, fieldCodeXml: string): string {
  // Case A (preferred): tag is the sole content of a <w:r>
  // Use [^<]*(?:<(?!/w:rPr>)[^<]*)* instead of .*? inside <w:rPr> to prevent
  // matching across element boundaries in minified (single-line) XML.
  const soloRunRegex = new RegExp(
    `<w:r[^>]*>(?:<w:rPr>[^<]*(?:<(?!/w:rPr>)[^<]*)*</w:rPr>)?<w:t[^>]*>${regexEscape(escapedZciteTag)}</w:t></w:r>`
  );

  if (soloRunRegex.test(xml)) {
    return xml.replace(soloRunRegex, fieldCodeXml);
  }

  // Case B (fallback): tag is inline with other text
  const inlineRegex = new RegExp(
    `(<w:r[^>]*>(?:<w:rPr>([^<]*(?:<(?!/w:rPr>)[^<]*)*)</w:rPr>)?<w:t[^>]*>)([^<]*)${regexEscape(escapedZciteTag)}([^<]*)(</w:t></w:r>)`
  );

  const inlineMatch = xml.match(inlineRegex);
  if (inlineMatch) {
    const rPr = inlineMatch[2] ? `<w:rPr>${inlineMatch[2]}</w:rPr>` : "";
    const textBefore = inlineMatch[3];
    const textAfter = inlineMatch[4];

    let replacement = "";
    if (textBefore) {
      replacement += `<w:r>${rPr}<w:t xml:space="preserve">${textBefore}</w:t></w:r>`;
    }
    replacement += fieldCodeXml;
    if (textAfter) {
      replacement += `<w:r>${rPr}<w:t xml:space="preserve">${textAfter}</w:t></w:r>`;
    }

    return xml.replace(inlineRegex, replacement);
  }

  return xml;
}

/** Scrittore Word: involucro sulle funzioni di oggi, l'output docx non cambia byte per byte. */
export const docxWriter: FormatWriter = {
  format: "docx",
  fieldType: "Field",
  bodyPart: "word/document.xml",
  app: "Word",
  invalidPackageMessage: (detail) => `Invalid .docx file: not a readable ZIP archive (${detail}). ${REGENERATE_DOCX}`,
  bodyMissingMessage: `Invalid .docx file: word/document.xml not found. ${REGENERATE_DOCX}`,
  sniff(zip: JSZip) {
    // un .odt passato come .docx: errore chiaro invece di "word/document.xml not found"
    if (zip.file("content.xml") && !zip.file("word/document.xml")) {
      throw new InjectionError("format_mismatch", 'This looks like a LibreOffice .odt, not a Word .docx. Use format "odt" (or a .odt file).');
    }
  },
  normalize: (bodyXml) => normalizeZciteTags(bodyXml),
  citationXml: (prepared: PreparedCitation) => generateZoteroFieldCode(prepared.items, prepared.formattedText),
  replaceTag: (bodyXml, rawTag, citationXml) => replaceZciteInXml(bodyXml, rawTag, citationXml),
  appendBibliography: (bodyXml) => bodyXml.replace("</w:body>", `${generateBibliographyFieldCode()}</w:body>`),
  writePrefs: (zip: JSZip, style: string) => writeZoteroDocumentPrefs(zip, style),
  prefsWarnings: (outcome: DocumentPrefsOutcome) => {
    if (outcome === "kept") return [EXISTING_PREFS_WARNING];
    if (outcome === "skipped") return [PREFS_NOT_WRITTEN_WARNING];
    return [];
  },
};
