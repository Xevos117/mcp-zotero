import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";
import { ZoteroApiInterface, ZoteroItemData } from "../types/zotero-types.js";
import { CslItemData, ZoteroCitationItem } from "../types/csl-types.js";
import { generateZoteroFieldCode, generateBibliographyFieldCode } from "./field-codes.js";
import { formatCitationText } from "./citation-formatter.js";
import { regexEscape, unescapeXml } from "./xml-utils.js";
import { normalizeZciteTags } from "./zcite-normalizer.js";
import { zoteroItemToCsl } from "../utils/csl-to-zotero.js";
import { LibraryType } from "../utils/library-context.js";

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

    if (!attrs["keys"]) continue;

    matches.push({
      fullMatch,
      keys: attrs["keys"].split(","),
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
    const response = await zoteroApi
      .library(libraryType, userId)
      .items(key)
      .get();
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
  const fileBuffer = await readFile(filePath);
  const zip = await JSZip.loadAsync(fileBuffer);

  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    throw new Error("Invalid .docx file: word/document.xml not found");
  }

  let documentXml = await documentEntry.async("string");
  documentXml = normalizeZciteTags(documentXml);

  const matches = parseZciteMatches(documentXml);

  if (matches.length === 0) {
    const outputPath = filePath.replace(".docx", "_cited.docx");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(outputPath, buffer);
    return { outputPath, found: 0, injected: 0, warnings: [] };
  }

  // Warn if using a numbered style but tags are missing the num attribute
  const warnings: string[] = [];
  if (style === "ieee" || style === "vancouver") {
    const withNum = matches.filter((m) => m.num !== undefined).length;
    if (withNum < matches.length) {
      warnings.push(
        `Style '${style}' requires 'num' attribute on <zcite> tags. Found ${withNum}/${matches.length} tags with num.`
      );
    }
  }

  // Collect all unique item keys
  const uniqueKeys = new Set(matches.flatMap((m) => m.keys));

  // Fetch CSL data from Zotero
  const cslData = await fetchCslData(uniqueKeys, zoteroApi, libraryType, userId);

  // Replace each zcite tag with a field code
  let injected = 0;
  for (const match of matches) {
    const citationItems = buildCitationItems(match, cslData, libraryType, userId);
    const itemDataList = match.keys.map(
      (k) => cslData.get(k) ?? { type: "article-journal" }
    );
    const formattedText = formatCitationText(itemDataList, style, match.num);
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

  // Save
  zip.file("word/document.xml", documentXml);
  const outputPath = filePath.replace(".docx", "_cited.docx");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, buffer);

  return { outputPath, found: matches.length, injected, warnings };
}
