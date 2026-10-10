#!/usr/bin/env node

// Standalone citation injection script for Claude skill usage.
// Reads a .docx with <zcite> tags and a metadata.json, injects Zotero field codes.
//
// Usage: node inject.mjs <input.docx> <output.docx> <metadata.json> <userId|libraryPath> [style]
// (ES module: copy it as inject.mjs so Node never treats it as CommonJS, whatever the
// nearest package.json says.)
//
// <libraryPath> is "users/<id>" or "groups/<id>" (library_path from get_user_id);
// a bare numeric ID is treated as a user ID for backward compatibility.
//
// Dependencies: jszip (npm install jszip)

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Resilient JSZip import: try ESM import first, then fall back to
// createRequire from the current working directory (needed when the
// script lives in a read-only skill directory without its own node_modules).
let JSZip;
try {
  JSZip = (await import("jszip")).default;
} catch {
  const { createRequire } = await import("node:module");
  const require = createRequire(process.cwd() + "/package.json");
  JSZip = require("jszip");
}

// Resilient fast-xml-parser import (same pattern as JSZip)
let fxp;
try {
  fxp = await import("fast-xml-parser");
} catch {
  const { createRequire } = await import("node:module");
  const require = createRequire(process.cwd() + "/package.json");
  fxp = require("fast-xml-parser");
}
const { XMLParser, XMLBuilder } = fxp;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.length < 4) {
  console.error(
    "Usage: node inject.js <input.docx> <output.docx> <metadata.json> <userId|libraryPath> [style]"
  );
  process.exit(1);
}

const [inputPath, outputPath, metadataPath, libraryArg, style = "apa"] = args;
const STYLES = ["apa", "ieee", "vancouver", "harvard", "chicago"];
if (!STYLES.includes(style)) {
  console.error(`Invalid style '${style}': expected one of ${STYLES.join(", ")}`);
  process.exit(1);
}
const libraryPath = /^\d+$/.test(libraryArg) ? `users/${libraryArg}` : libraryArg;
if (!/^(users|groups)\/\d+$/.test(libraryPath)) {
  console.error(
    `Invalid library '${libraryArg}': expected a numeric user ID, "users/<id>" or "groups/<id>"`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Zotero itemType → CSL type mapping
// ---------------------------------------------------------------------------

const ZOTERO_TO_CSL_TYPE = {
  journalArticle: "article-journal",
  book: "book",
  bookSection: "chapter",
  conferencePaper: "paper-conference",
  report: "report",
  thesis: "thesis",
  webpage: "webpage",
  document: "dataset",
};

// ---------------------------------------------------------------------------
// Metadata conversion: simplified JSON → CSL-JSON
// ---------------------------------------------------------------------------

/**
 * Parse an author string like "John Smith, Jane Doe" into CslName[].
 * Each name token is split on whitespace; the last word is `family`, the rest is `given`.
 * @param {string} authorString
 * @returns {Array<{family: string, given: string}>}
 */
function parseAuthors(authorString) {
  if (!authorString) return [];
  return authorString.split(",").map((name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { family: parts[0], given: "" };
    const family = parts[parts.length - 1];
    const given = parts.slice(0, -1).join(" ");
    return { family, given };
  });
}

/**
 * Parse a date string (e.g. "2017", "2017-03", "2017-03-15") into a CslDate.
 * @param {string} dateString
 * @returns {{[key: string]: unknown} | undefined}
 */
function parseDate(dateString) {
  if (!dateString) return undefined;
  const parts = dateString
    .split("-")
    .map(Number)
    .filter((n) => !isNaN(n));
  if (parts.length === 0) return undefined;
  return { "date-parts": [parts] };
}

/**
 * Convert a single metadata entry (simplified format) to CSL-JSON.
 * Excludes `abstract` to keep field codes small.
 * @param {Record<string, unknown>} meta
 * @returns {Record<string, unknown>}
 */
function metadataToCsl(meta) {
  const cslType = ZOTERO_TO_CSL_TYPE[meta.itemType] ?? "article-journal";
  const authors = parseAuthors(meta.authors);
  const issued = parseDate(meta.date);

  /** @type {Record<string, unknown>} */
  const csl = { type: cslType };

  if (meta.title) csl.title = meta.title;
  if (authors.length > 0) csl.author = authors;
  if (issued) csl.issued = issued;
  // Accept both uppercase (Zotero-style) and lowercase (MCP response) field names
  if (meta.DOI || meta.doi) csl.DOI = meta.DOI || meta.doi;
  if (meta.containerTitle || meta.publicationTitle)
    csl["container-title"] = meta.containerTitle || meta.publicationTitle;
  if (meta.volume) csl.volume = meta.volume;
  if (meta.issue) csl.issue = meta.issue;
  if (meta.page || meta.pages) csl.page = meta.page || meta.pages;
  if (meta.publisher) csl.publisher = meta.publisher;
  if (meta.publisherPlace) csl["publisher-place"] = meta.publisherPlace;
  if (meta.URL || meta.url) csl.URL = meta.URL || meta.url;

  return csl;
}

/**
 * Convert the full metadata object to a Map<itemKey, CslItemData>.
 * @param {Record<string, Record<string, unknown>>} metadata
 * @returns {Map<string, Record<string, unknown>>}
 */
function convertMetadataToCsl(metadata) {
  const map = new Map();
  for (const [key, meta] of Object.entries(metadata)) {
    map.set(key, metadataToCsl(meta));
  }
  return map;
}

// ---------------------------------------------------------------------------
// XML utilities (ported from xml-utils.ts)
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * @param {string} text
 * @returns {string}
 */
function regexEscape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} text
 * @returns {string}
 */
function unescapeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // MUST be last to avoid double-unescaping
}

// ---------------------------------------------------------------------------
// Citation text formatter (ported from citation-formatter.ts)
// ---------------------------------------------------------------------------

/**
 * @param {Array<Record<string, unknown>>} items
 * @param {string} citationStyle
 * @param {string} [num]
 * @returns {string}
 */
function formatCitationText(items, citationStyle, num) {
  if (citationStyle === "ieee" || citationStyle === "vancouver") {
    return num ? `[${num}]` : "[?]";
  }

  const parts = items.map((item) => {
    const authors = item.author;
    const firstAuthor = authors?.[0]?.family ?? "Unknown";
    const year =
      item.issued?.["date-parts"]?.[0]?.[0]?.toString() ?? "n.d.";

    let authorText;
    if (!authors || authors.length === 0) {
      const title = item.title;
      authorText = title
        ? title.length > 30
          ? `"${title.substring(0, 30)}..."`
          : `"${title}"`
        : "Unknown";
    } else if (authors.length > 2) {
      authorText = `${firstAuthor} et al.`;
    } else if (authors.length === 2) {
      authorText = `${firstAuthor} & ${authors[1].family}`;
    } else {
      authorText = firstAuthor;
    }

    return `${authorText}, ${year}`;
  });

  return `(${parts.join("; ")})`;
}

// ---------------------------------------------------------------------------
// Field code generation (ported from field-codes.ts)
// ---------------------------------------------------------------------------

/**
 * @param {Array<Record<string, unknown>>} citationItems
 * @param {string} formattedText
 * @returns {string}
 */
function generateZoteroFieldCode(citationItems, formattedText) {
  const citationId = randomUUID().slice(0, 8);

  const cslCitation = {
    citationID: citationId,
    properties: { formattedCitation: formattedText },
    citationItems,
    schema:
      "https://github.com/citation-style-language/schema/raw/master/csl-citation.json",
  };

  const instrText = ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(cslCitation)} `;
  const escapedInstrText = escapeXml(instrText);

  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapedInstrText}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r><w:rPr><w:noProof/></w:rPr><w:t>${escapeXml(formattedText)}</w:t></w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join("");
}

/**
 * @returns {string}
 */
function generateBibliographyFieldCode() {
  return [
    "<w:p>",
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    '<w:r><w:instrText xml:space="preserve">',
    ' ADDIN ZOTERO_BIBL {&quot;uncited&quot;:[],&quot;omitted&quot;:[],&quot;custom&quot;:[]} CSL_BIBLIOGRAPHY ',
    "</w:instrText></w:r>",
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    "<w:r><w:rPr><w:noProof/></w:rPr><w:t>[Bibliography will be generated by Zotero]</w:t></w:r>",
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    "</w:p>",
  ].join("");
}

// ---------------------------------------------------------------------------
// Zcite normalization (ported from zcite-normalizer.ts)
// ---------------------------------------------------------------------------

const ZCITE_PATTERN = /&lt;zcite\s+[\s\S]*?\/&gt;/;

const FXP_PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
};

const FXP_BUILDER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  format: false,
  suppressEmptyNode: false,
  suppressBooleanAttributes: false,
};

function extractRunText(runChildren) {
  let text = "";
  for (const child of runChildren) {
    if ("w:t" in child) {
      const wtChildren = child["w:t"];
      for (const tc of wtChildren) {
        if ("#text" in tc) {
          text += String(tc["#text"]);
        }
      }
    }
  }
  return text;
}

function isRunNode(node) {
  return "w:r" in node;
}

function hasTextContent(runChildren) {
  return runChildren.some((child) => "w:t" in child);
}

function collectConsecutiveRunGroups(children) {
  const groups = [];
  let currentGroup = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isRunNode(child)) {
      const runChildren = child["w:r"];
      if (hasTextContent(runChildren)) {
        const text = extractRunText(runChildren);
        if (currentGroup) {
          currentGroup.endIndex = i;
          currentGroup.texts.push(text);
        } else {
          currentGroup = { startIndex: i, endIndex: i, texts: [text] };
        }
        continue;
      }
    }
    if (currentGroup && currentGroup.texts.length >= 2) {
      groups.push(currentGroup);
    }
    currentGroup = null;
  }
  if (currentGroup && currentGroup.texts.length >= 2) {
    groups.push(currentGroup);
  }

  return groups;
}

function findSplitZcite(group) {
  const { texts } = group;

  for (let start = 0; start < texts.length; start++) {
    let concat = "";
    for (let end = start; end < texts.length; end++) {
      concat += texts[end];
      if (end <= start) continue;

      const m = ZCITE_PATTERN.exec(concat);
      if (m) {
        const matchStart = m.index;
        const matchEnd = m.index + m[0].length;
        const lastRunStart = concat.length - texts[end].length;
        if (matchStart < lastRunStart && matchEnd > lastRunStart) {
          return { startOffset: start, endOffset: end };
        }
      }
    }
  }
  return null;
}

function mergeRunsInPlace(children, group, startOffset, endOffset) {
  const absStart = group.startIndex + startOffset;
  const absEnd = group.startIndex + endOffset;
  const count = absEnd - absStart + 1;

  let mergedText = "";
  for (let i = absStart; i <= absEnd; i++) {
    const runChildren = children[i]["w:r"];
    mergedText += extractRunText(runChildren);
  }

  const firstRunChildren = children[absStart]["w:r"];
  const newRunChildren = [];

  for (const child of firstRunChildren) {
    if ("w:rPr" in child) {
      newRunChildren.push(child);
      break;
    }
  }

  newRunChildren.push({
    "w:t": [{ "#text": mergedText }],
    ":@": { "@_xml:space": "preserve" },
  });

  const newRun = { "w:r": newRunChildren };

  const firstRunAttrs = children[absStart][":@"];
  if (firstRunAttrs) {
    newRun[":@"] = firstRunAttrs;
  }

  children.splice(absStart, count, newRun);
}

function normalizeParagraphRuns(children) {
  let modified = false;

  let changed = true;
  while (changed) {
    changed = false;
    const groups = collectConsecutiveRunGroups(children);

    for (const group of groups) {
      const split = findSplitZcite(group);
      if (split) {
        mergeRunsInPlace(children, group, split.startOffset, split.endOffset);
        modified = true;
        changed = true;
        break;
      }
    }
  }

  return modified;
}

function walkAndNormalize(nodes) {
  let modified = false;

  for (const node of nodes) {
    if ("w:p" in node) {
      const pChildren = node["w:p"];
      if (normalizeParagraphRuns(pChildren)) {
        modified = true;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === ":@" || key === "#text") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        if (walkAndNormalize(value)) {
          modified = true;
        }
      }
    }
  }

  return modified;
}

/**
 * Pre-process document.xml to merge zcite tags split across multiple w:r runs.
 * @param {string} documentXml
 * @returns {string}
 */
function normalizeZciteTags(documentXml) {
  if (!documentXml.includes("zcite")) {
    return documentXml;
  }

  const parser = new XMLParser(FXP_PARSER_OPTIONS);
  const parsed = parser.parse(documentXml);

  const modified = walkAndNormalize(parsed);

  if (!modified) {
    return documentXml;
  }

  const builder = new XMLBuilder(FXP_BUILDER_OPTIONS);
  return builder.build(parsed);
}

// ---------------------------------------------------------------------------
// Zcite parsing (ported from injector.ts)
// ---------------------------------------------------------------------------

/**
 * @param {string} documentXml
 * @returns {Array<{fullMatch: string, keys: string[], locator?: string, prefix?: string, suffix?: string, num?: string}>}
 */
function parseZciteMatches(documentXml) {
  const findRegex = /&lt;zcite\s+[\s\S]*?\/&gt;/g;
  const matches = [];
  let findMatch;

  while ((findMatch = findRegex.exec(documentXml)) !== null) {
    const fullMatch = findMatch[0];
    const cleanTag = unescapeXml(fullMatch);

    const attrRegex = /(\w+)="([^"]*)"/g;
    const attrs = {};
    let attrMatch;
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

/**
 * @param {{fullMatch: string, keys: string[], locator?: string, prefix?: string, suffix?: string, num?: string}} match
 * @param {Map<string, Record<string, unknown>>} cslData
 * @param {string} libPath - "users/<id>" or "groups/<id>"
 * @returns {Array<Record<string, unknown>>}
 */
function buildCitationItems(match, cslData, libPath) {
  return match.keys.map((key, idx) => {
    const itemData = cslData.get(key) ?? { type: "article-journal" };
    const item = {
      id: idx,
      uris: [`http://zotero.org/${libPath}/items/${key}`],
      uri: [`http://zotero.org/${libPath}/items/${key}`],
      itemData,
    };
    if (match.locator) item.locator = match.locator;
    if (match.prefix) item.prefix = match.prefix;
    if (match.suffix) item.suffix = match.suffix;
    return item;
  });
}

/**
 * @param {string} xml
 * @param {string} escapedZciteTag
 * @param {string} fieldCodeXml
 * @returns {string}
 */
function replaceZciteInXml(xml, escapedZciteTag, fieldCodeXml) {
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

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  // 1. Read input .docx
  const fileBuffer = await readFile(inputPath);
  const zip = await JSZip.loadAsync(fileBuffer);

  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) {
    throw new Error("Invalid .docx file: word/document.xml not found");
  }

  let documentXml = await documentEntry.async("string");
  documentXml = normalizeZciteTags(documentXml);

  // 2. Read metadata.json
  const metadataRaw = await readFile(metadataPath, "utf-8");
  const metadata = JSON.parse(metadataRaw);

  // 3. Convert metadata to CSL-JSON map
  const cslData = convertMetadataToCsl(metadata);

  // 4. Parse <zcite> tags
  const matches = parseZciteMatches(documentXml);

  if (matches.length === 0) {
    // No citations found — write unmodified
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await writeFile(outputPath, buffer);
    console.log(
      JSON.stringify({ output: outputPath, found: 0, injected: 0 })
    );
    return;
  }

  // 4b. Warn if using a numbered style but tags are missing the num attribute
  if (style === "ieee" || style === "vancouver") {
    const withNum = matches.filter((m) => m.num !== undefined).length;
    if (withNum < matches.length) {
      console.error(
        `WARNING: Style '${style}' requires 'num' attribute on <zcite> tags. Found ${withNum}/${matches.length} tags with num.`
      );
    }
  }

  // 4c. Warn about cited keys missing from metadata.json (they would render as "Unknown, n.d.")
  const missingKeys = [...new Set(matches.flatMap((m) => m.keys))].filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    console.error(
      `WARNING: ${missingKeys.length} cited key(s) not found in metadata.json: ${missingKeys.join(", ")}. Their citations will show "Unknown" until Zotero refreshes them.`
    );
  }

  // 5. Replace each zcite tag with a field code
  let injected = 0;
  for (const match of matches) {
    const citationItems = buildCitationItems(match, cslData, libraryPath);
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

  // 6. Append bibliography before </w:body>
  const biblXml = generateBibliographyFieldCode();
  documentXml = documentXml.replace("</w:body>", `${biblXml}</w:body>`);

  // 7. Write output .docx
  zip.file("word/document.xml", documentXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outputPath, buffer);

  console.log(
    JSON.stringify({
      output: outputPath,
      found: matches.length,
      injected,
    })
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
