import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";
import { format, parse } from "node:path";
import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { CslItemData, ZoteroCitationItem } from "../types/csl-types.js";
import { generateZoteroFieldCode, generateBibliographyFieldCode } from "./field-codes.js";
import { formatCitationText } from "./citation-formatter.js";
import { regexEscape, unescapeXml } from "./xml-utils.js";
import { normalizeZciteTags } from "./zcite-normalizer.js";
import { EXISTING_PREFS_WARNING, PREFS_NOT_WRITTEN_WARNING, writeZoteroDocumentPrefs } from "./document-prefs.js";
import { zoteroItemToCsl } from "../utils/csl-to-zotero.js";
import { LibraryType } from "../utils/library-context.js";
import { ZOTERO_KEY } from "../utils/zotero-keys.js";

export interface InjectionResult {
  outputPath: string;
  found: number;
  injected: number;
  warnings: string[];
}

interface ZciteMatch {
  fullMatch: string;
  keys: string[];
  locator?: string;
  prefix?: string;
  suffix?: string;
  num?: string;
}

const REGENERATE_DOCX =
  "The file is not a Word document or is corrupted: create it again as .docx (e.g. with the docx npm package) and call again.";

const NO_ZCITE_WARNING =
  'No <zcite> placeholders found: the output is an unchanged copy. Write them in the document body as <zcite keys="ITEMKEY"/> ' +
  "(headers, footers, footnotes and comments are not scanned).";

function parseZciteMatches(documentXml: string): ZciteMatch[] {
  const findRegex = /&lt;zcite\s+[\s\S]*?\/&gt;/g;
  const matches: ZciteMatch[] = [];
  let findMatch: RegExpExecArray | null;

  while ((findMatch = findRegex.exec(documentXml)) !== null) {
    const fullMatch = findMatch[0];
    const cleanTag = unescapeXml(fullMatch);

    const attrRegex = /(\w+)="([^"]*)"/g;
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(cleanTag)) !== null) {
      // Unescape attribute values since the zcite tag is XML
      // and values like "pp. 12 &amp; 15" need a second unescape
      attrs[attrMatch[1]] = unescapeXml(attrMatch[2]);
    }

    // Tolerate "KEY1, KEY2": a stray space would otherwise become part of the key (404 on fetch)
    const keys = (attrs["keys"] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) continue;

    matches.push({
      fullMatch,
      keys,
      locator: attrs["locator"] || undefined,
      prefix: attrs["prefix"] || undefined,
      suffix: attrs["suffix"] || undefined,
      num: attrs["num"] || undefined,
    });
  }
  return matches;
}

async function fetchCslData(
  keys: Set<string>,
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  userId: string
): Promise<Map<string, CslItemData>> {
  const cslData = new Map<string, CslItemData>();

  for (const key of keys) {
    let response;
    try {
      response = await zoteroApi
        .library(libraryType, userId)
        .items(key)
        .get();
    } catch (err) {
      // Unknown keys are collected and reported together by the caller; any other failure aborts at once
      if (isZoteroApiError(err) && err.response?.status === 404) continue;
      throw err;
    }
    const zoteroItem = response.getData() as ZoteroItemData;
    cslData.set(key, zoteroItemToCsl(zoteroItem));
  }

  return cslData;
}

function buildCitationItems(
  match: ZciteMatch,
  cslData: Map<string, CslItemData>,
  libraryType: LibraryType,
  userId: string
): ZoteroCitationItem[] {
  return match.keys.map((key, idx) => {
    const itemData = cslData.get(key) ?? { type: "article-journal" };
    const item: ZoteroCitationItem = {
      id: idx,
      uris: [`http://zotero.org/${libraryType}s/${userId}/items/${key}`],
      uri: [`http://zotero.org/${libraryType}s/${userId}/items/${key}`],
      itemData,
    };
    if (match.locator) item.locator = match.locator;
    if (match.prefix) item.prefix = match.prefix;
    if (match.suffix) item.suffix = match.suffix;
    return item;
  });
}

function replaceZciteInXml(
  xml: string,
  escapedZciteTag: string,
  fieldCodeXml: string
): string {
  // Case A (preferred): tag is the sole content of a <w:r>
  // Use [^<]*(?:<(?!/w:rPr>)[^<]*)* instead of .*? inside <w:rPr> to prevent
  // matching across element boundaries in minified (single-line) XML.
  const soloRunRegex = new RegExp(
    `<w:r>(?:<w:rPr>[^<]*(?:<(?!/w:rPr>)[^<]*)*</w:rPr>)?<w:t[^>]*>${regexEscape(escapedZciteTag)}</w:t></w:r>`
  );

  if (soloRunRegex.test(xml)) {
    return xml.replace(soloRunRegex, fieldCodeXml);
  }

  // Case B (fallback): tag is inline with other text
  const inlineRegex = new RegExp(
    `(<w:r>(?:<w:rPr>([^<]*(?:<(?!/w:rPr>)[^<]*)*)</w:rPr>)?<w:t[^>]*>)([^<]*)${regexEscape(escapedZciteTag)}([^<]*)(</w:t></w:r>)`
  );

  const inlineMatch = xml.match(inlineRegex);
  if (inlineMatch) {
    const rPr = inlineMatch[2]
      ? `<w:rPr>${inlineMatch[2]}</w:rPr>`
      : "";
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

export async function injectCitations(
  filePath: string,
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  userId: string,
  style: string
): Promise<InjectionResult> {
  // Derive "<name>_cited<ext>" from the basename only: a directory containing ".docx" stays untouched
  const { dir, name, ext } = parse(filePath);
  const outputPath = format({ dir, name: `${name}_cited`, ext });

  const fileBuffer = await readFile(filePath);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch (err) {
    throw new Error(`Invalid .docx file: not a readable ZIP archive (${err instanceof Error ? err.message : String(err)}). ${REGENERATE_DOCX}`);
  }

  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    throw new Error(`Invalid .docx file: word/document.xml not found. ${REGENERATE_DOCX}`);
  }

  let documentXml = await documentEntry.async("string");
  documentXml = normalizeZciteTags(documentXml);

  const matches = parseZciteMatches(documentXml);

  if (matches.length === 0) {
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(outputPath, buffer);
    return { outputPath, found: 0, injected: 0, warnings: [NO_ZCITE_WARNING] };
  }

  // Warn if using a numbered style but tags are missing the num attribute
  const warnings: string[] = [];
  if (style === "ieee" || style === "vancouver") {
    const withNum = matches.filter((m) => m.num !== undefined).length;
    if (withNum < matches.length) {
      warnings.push(
        `Style '${style}' requires 'num' attribute on <zcite> tags. Found ${withNum}/${matches.length} tags with num. ` +
          "Citations without num show [?] until the user runs Zotero → Refresh in Word; to get the numbers now, add " +
          'num="N" (order of first citation) to every <zcite> in the original file and run again.'
      );
    }
  }

  // Collect all unique item keys
  const uniqueKeys = new Set(matches.flatMap((m) => m.keys));
  // Keys from the document go into API URL paths (one GET per key) and Zotero URIs: only well-formed Zotero
  // keys, so a crafted <zcite> cannot point the request at another endpoint ("../", "?", "&"), and a key Zotero
  // would reject never reaches the document. The skill's inject.js applies the same check
  const invalid = [...uniqueKeys].filter((k) => !ZOTERO_KEY.test(k));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid Zotero item key(s) in <zcite>: ${invalid.join(", ")} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ). ` +
        "No file was written. Use the keys returned by search_library, add_items_by_doi or add_items."
    );
  }

  // Fetch CSL data from Zotero
  const cslData = await fetchCslData(uniqueKeys, zoteroApi, libraryType, userId);
  // No placeholder citations in the user's document: a citation of a nonexistent item fails the injection,
  // like the skill's inject.js with a key missing from metadata.json
  const missingKeys = [...uniqueKeys].filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    throw new Error(
      `${missingKeys.length} cited key(s) not found in the library: ${missingKeys.join(", ")}. No file was written. ` +
        "Fix these keys in the document (find existing items with search_library, or add the missing ones with add_items_by_doi " +
        "or add_items) and call again; for a group library pass library_type and library_id."
    );
  }

  // Replace each zcite tag with a field code
  let injected = 0;
  for (const match of matches) {
    const citationItems = buildCitationItems(match, cslData, libraryType, userId);
    const itemDataList = match.keys.map(
      (k) => cslData.get(k) ?? { type: "article-journal" }
    );
    const formattedText = formatCitationText(itemDataList, style, match);
    const fieldCodeXml = generateZoteroFieldCode(citationItems, formattedText);

    const newXml = replaceZciteInXml(documentXml, match.fullMatch, fieldCodeXml);
    if (newXml !== documentXml) {
      documentXml = newXml;
      injected++;
    }
  }

  // Append bibliography before </w:body>
  const biblXml = generateBibliographyFieldCode();
  documentXml = documentXml.replace("</w:body>", `${biblXml}</w:body>`);

  // Document preferences (style, field type) where Zotero for Word reads them: no Document Preferences dialog
  // on the first Refresh, the injected style is applied (H-W1)
  zip.file("word/document.xml", documentXml);
  const prefs = await writeZoteroDocumentPrefs(zip, style);
  if (prefs === "kept") warnings.push(EXISTING_PREFS_WARNING);
  if (prefs === "skipped") warnings.push(PREFS_NOT_WRITTEN_WARNING);

  // Save
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, buffer);

  return { outputPath, found: matches.length, injected, warnings };
}
