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

import { randomBytes, randomUUID } from "node:crypto";
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

// Same table as src/utils/csl-to-zotero.ts (inject_citations), so both produce the same CSL type
const ZOTERO_TO_CSL_TYPE = {
  journalArticle: "article-journal",
  magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper",
  bill: "bill",
  book: "book",
  tvBroadcast: "broadcast",
  bookSection: "chapter",
  dataset: "dataset",
  document: "document",
  dictionaryEntry: "entry-dictionary",
  encyclopediaArticle: "entry-encyclopedia",
  artwork: "graphic",
  hearing: "hearing",
  interview: "interview",
  case: "legal_case",
  statute: "legislation",
  manuscript: "manuscript",
  map: "map",
  film: "motion_picture",
  conferencePaper: "paper-conference",
  patent: "patent",
  letter: "personal_communication",
  forumPost: "post",
  blogPost: "post-weblog",
  report: "report",
  computerProgram: "software",
  audioRecording: "song",
  presentation: "speech",
  standard: "standard",
  thesis: "thesis",
  webpage: "webpage",
  radioBroadcast: "broadcast",
  videoRecording: "motion_picture",
  preprint: "article",
  podcast: "song",
  email: "personal_communication",
  instantMessage: "personal_communication",
};

// Same table as CONTAINER_TITLE_FIELD in src/utils/csl-to-zotero.ts: Zotero field holding the CSL container-title
const CONTAINER_TITLE_FIELD = {
  journalArticle: "publicationTitle",
  magazineArticle: "publicationTitle",
  newspaperArticle: "publicationTitle",
  bookSection: "bookTitle",
  dictionaryEntry: "dictionaryTitle",
  conferencePaper: "proceedingsTitle",
  blogPost: "blogTitle",
  encyclopediaArticle: "encyclopediaTitle",
  forumPost: "forumTitle",
  webpage: "websiteTitle",
  radioBroadcast: "programTitle",
  tvBroadcast: "programTitle",
  podcast: "programTitle",
};

// Same table as CSL_NAME_CREATOR_TYPES in src/utils/csl-to-zotero.ts: CSL name variable ← Zotero creatorType
const CSL_NAME_CREATOR_TYPES = [
  ["author", "author"],
  ["editor", "editor"],
  ["container-author", "bookAuthor"],
  ["collection-editor", "seriesEditor"],
  ["translator", "translator"],
];

// Same rule as ZOTERO_KEY in src/utils/zotero-keys.ts: 8 characters, never 0, 1, O or lowercase
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

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
  // "No authors listed" is get_items_details' placeholder, not a name
  if (!authorString || authorString === "No authors listed") return [];
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
/**
 * CSL names from get_items_details' structured `creators`, by role (same rule as the inject_citations
 * MCP tool: a single-field name, e.g. an institution, is a CSL `literal`).
 * @param {Array<Record<string, string>>} creators
 * @returns {Record<string, Array<Record<string, string>>>}
 */
function namesFromCreators(creators) {
  const names = {};
  for (const [variable, creatorType] of CSL_NAME_CREATOR_TYPES) {
    const list = creators
      .filter((c) => c.creatorType === creatorType)
      .map((c) => (c.name && !c.lastName ? { literal: c.name } : { family: c.lastName ?? "", given: c.firstName ?? "" }));
    if (list.length > 0) names[variable] = list;
  }
  return names;
}

function metadataToCsl(meta) {
  const cslType = ZOTERO_TO_CSL_TYPE[meta.itemType] ?? "article-journal";
  // Prefer structured creators; the "authors" string cannot tell "de Kroon" from a middle name
  const authors = parseAuthors(meta.authors);
  const names = Array.isArray(meta.creators)
    ? namesFromCreators(meta.creators)
    : authors.length > 0 ? { author: authors } : {};
  const issued = parseDate(meta.date);

  /** @type {Record<string, unknown>} */
  const csl = { type: cslType };

  if (meta.title) csl.title = meta.title;
  Object.assign(csl, names);
  if (issued) csl.issued = issued;
  // Accept both uppercase (Zotero-style) and lowercase (MCP response) field names
  if (meta.DOI || meta.doi) csl.DOI = meta.DOI || meta.doi;
  // bookTitle, proceedingsTitle, ... as get_items_details returns them; containerTitle for older metadata files
  const container = meta.containerTitle || meta[CONTAINER_TITLE_FIELD[meta.itemType]] || meta.publicationTitle;
  if (container) csl["container-title"] = container;
  if (meta.volume) csl.volume = meta.volume;
  if (meta.issue) csl.issue = meta.issue;
  if (meta.page || meta.pages) csl.page = meta.page || meta.pages;
  if (meta.publisher) csl.publisher = meta.publisher;
  // get_items_details returns Zotero's field name "place"; publisherPlace kept for older metadata files
  if (meta.publisherPlace || meta.place) csl["publisher-place"] = meta.publisherPlace || meta.place;
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
    // get_items_details' not_found list (and anything else that is not an item) is not metadata
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
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

// Differences between the author-date styles in the placeholder text, as citeproc renders them
const AUTHOR_DATE = {
  apa: { yearSep: ", ", and: "&", pageLabel: true },
  harvard: { yearSep: ", ", and: "and", pageLabel: true },
  chicago: { yearSep: " ", and: "and", pageLabel: false },
};

/**
 * Locator as citeproc renders a locator without label (= page): "12" → "p. 12", "12-15" → "pp. 12–15".
 * @param {string} locator
 * @param {boolean} pageLabel
 * @returns {string}
 */
function formatLocator(locator, pageLabel) {
  const bare = locator.trim().replace(/^pp?\.\s*/i, "");
  if (!/^[\divxlcdm]/i.test(bare) || /^[a-z]{2,}\.?\s/i.test(bare)) return locator.trim();
  const pages = bare.replace(/(\d)\s*-+\s*(\d)/g, "$1–$2");
  if (!pageLabel) return pages;
  return `${/[–,&]/.test(pages) ? "pp." : "p."} ${pages}`;
}

/**
 * @param {{prefix?: string, suffix?: string}} opts
 * @returns {{prefix: string, suffix: string}}
 */
function affixes(opts) {
  const prefix = opts.prefix?.trim() ? `${opts.prefix.trim()} ` : "";
  const s = opts.suffix?.trim() ?? "";
  const suffix = !s ? "" : /^[,;.:)\]]/.test(s) ? s : ` ${s}`;
  return { prefix, suffix };
}

/**
 * @param {string} num
 * @param {number} count
 * @returns {string[] | undefined}
 */
function numbersPerItem(num, count) {
  const out = [];
  for (const part of num.split(",").map((p) => p.trim())) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(String(n));
    else out.push(part);
  }
  return out.length === count ? out : undefined;
}

/**
 * @param {number} count
 * @param {string} citationStyle
 * @param {{num?: string, locator?: string, prefix?: string, suffix?: string}} opts
 * @returns {string}
 */
function numberedText(count, citationStyle, opts) {
  const num = opts.num ?? "?";
  const { prefix, suffix } = affixes(opts);
  const locator = opts.locator && citationStyle === "ieee" ? `, ${formatLocator(opts.locator, true)}` : "";
  if (!prefix && !suffix && !locator) return `[${num}]`;
  const perItem = numbersPerItem(num, count) ?? [num];
  if (citationStyle === "ieee") return perItem.map((n) => `${prefix}[${n}${locator}]${suffix}`).join(", ");
  return `[${perItem.map((n) => `${prefix}${n}${suffix}`).join(",")}]`;
}

/**
 * @param {Array<Record<string, any>>} items
 * @param {string} citationStyle
 * @param {{num?: string, locator?: string, prefix?: string, suffix?: string}} [opts]
 * @returns {string}
 */
function formatCitationText(items, citationStyle, opts = {}) {
  if (citationStyle === "ieee" || citationStyle === "vancouver") {
    return numberedText(items.length, citationStyle, opts);
  }

  const rules = AUTHOR_DATE[citationStyle] ?? AUTHOR_DATE.apa;
  const { prefix, suffix } = affixes(opts);
  const locator = opts.locator ? `, ${formatLocator(opts.locator, rules.pageLabel)}` : "";
  const parts = items.map((item) => {
    const authors = item.author;
    const name = (a) => a.family ?? a.literal ?? "Unknown";
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
      authorText = `${name(authors[0])} et al.`;
    } else if (authors.length === 2) {
      authorText = `${name(authors[0])} ${rules.and} ${name(authors[1])}`;
    } else {
      authorText = name(authors[0]);
    }

    return `${prefix}${authorText}${rules.yearSep}${year}${locator}${suffix}`;
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
// Zotero document preferences (same as src/citation-injector/document-prefs.ts of the MCP server: keep in sync)
// ---------------------------------------------------------------------------

// docProps/custom.xml with ZOTERO_PREF_1…n (at most 255 characters each), as Zotero for Word writes them: without
// them the first Refresh opens Document Preferences and proposes Zotero's last style instead of the injected one.
// A document that already has ZOTERO_PREF_* is left as it is.
const ZOTERO_STYLE_IDS = {
  apa: "http://www.zotero.org/styles/apa",
  ieee: "http://www.zotero.org/styles/ieee",
  vancouver: "http://www.zotero.org/styles/nlm-citation-sequence",
  harvard: "http://www.zotero.org/styles/harvard-cite-them-right",
  chicago: "http://www.zotero.org/styles/chicago-author-date",
};
const CUSTOM_PART = "docProps/custom.xml";
const CUSTOM_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const CUSTOM_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
const PREFS_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
const PREF_CHUNK = 255;
const SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const escapeXmlAttr = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function zoteroDocumentData(styleId) {
  const session = [...randomBytes(8)].map((b) => SESSION_ALPHABET[b % SESSION_ALPHABET.length]).join("");
  return (
    `<data data-version="3"><session id="${session}"/>` +
    `<style id="${escapeXmlAttr(styleId)}" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/>` +
    `<prefs><pref name="fieldType" value="Field"/></prefs></data>`
  );
}

const EXISTING_PREFS_WARNING =
  "The document already has Zotero document preferences (ZOTERO_PREF_* in docProps/custom.xml): kept as they are, so on the " +
  "first Refresh Zotero uses the style saved there, not the style of this injection.";

const PREFS_NOT_WRITTEN_WARNING =
  "Zotero document preferences not written: the document's custom properties part could not be merged into, so Zotero may " +
  "ask for the document style (Document Preferences) on the first Refresh.";

// Part name of the custom properties: the target of the package relationship if there is one, else docProps/custom.xml
function customPartName(rels) {
  for (const m of (rels ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    if (!m[0].includes(CUSTOM_REL_TYPE)) continue;
    const target = /\bTarget=["']([^"']+)["']/.exec(m[0])?.[1];
    if (target) return target.replace(/^\/+/, "");
  }
  return CUSTOM_PART;
}

// "written", "kept" (the document already has Zotero preferences) or "skipped" (nothing written; an existing part
// that cannot be merged into is never rewritten)
async function writeZoteroDocumentPrefs(zip, styleName) {
  const styleId = ZOTERO_STYLE_IDS[styleName];
  if (!styleId) return "skipped";
  const rels = await zip.file("_rels/.rels")?.async("string");
  const part = customPartName(rels);
  const existing = await zip.file(part)?.async("string");
  if (existing && /\bname=["']ZOTERO_PREF_\d+["']/.test(existing)) return "kept";

  const value = zoteroDocumentData(styleId);
  const chunks = [];
  for (let i = 0; i < value.length; i += PREF_CHUNK) chunks.push(value.slice(i, i + PREF_CHUNK));
  const pids = [...(existing ?? "").matchAll(/\bpid=["'](\d+)["']/g)].map((m) => Number(m[1]));
  let pid = Math.max(1, ...pids);
  const root = existing ? /<(\w+:)?Properties\b([^>]*?)(\/?)>/.exec(existing) : null;
  const prefix = root?.[1] ?? "";
  const properties = chunks
    .map((chunk, i) => `<${prefix}property fmtid="${PREFS_FMTID}" pid="${++pid}" name="ZOTERO_PREF_${i + 1}"><vt:lpwstr>${escapeXmlAttr(chunk)}</vt:lpwstr></${prefix}property>`)
    .join("");
  if (existing) {
    if (!root) return "skipped";
    let merged;
    if (root[3]) {
      merged = existing.replace(root[0], `<${prefix}Properties${root[2]}>${properties}</${prefix}Properties>`);
    } else {
      const close = `</${prefix}Properties>`;
      const at = existing.lastIndexOf(close);
      if (at < 0) return "skipped";
      merged = existing.slice(0, at) + properties + existing.slice(at);
    }
    if (!/xmlns:vt=/.test(merged)) merged = merged.replace(`<${prefix}Properties`, `<${prefix}Properties xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"`);
    if (merged === existing || !merged.includes(properties)) return "skipped";
    zip.file(part, merged);
  } else {
    zip.file(
      part,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
        `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${properties}</Properties>`
    );
  }
  const typesEntry = zip.file("[Content_Types].xml");
  if (typesEntry) {
    const types = await typesEntry.async("string");
    if (!types.includes(`PartName="/${part}"`)) {
      zip.file("[Content_Types].xml", types.replace("</Types>", `<Override PartName="/${part}" ContentType="${CUSTOM_CONTENT_TYPE}"/></Types>`));
    }
  }
  if (rels !== undefined && !rels.includes(CUSTOM_REL_TYPE)) {
    const ids = new Set([...rels.matchAll(/\bId=["']([^"']+)["']/g)].map((m) => m[1]));
    let n = 1;
    while (ids.has(`rId${n}`)) n++;
    zip.file("_rels/.rels", rels.replace("</Relationships>", `<Relationship Id="rId${n}" Type="${CUSTOM_REL_TYPE}" Target="${part}"/></Relationships>`));
  }
  return "written";
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

  // 4a. Same rule as inject_citations: keys end up in Zotero URIs, so only well-formed Zotero keys
  const invalidKeys = [...new Set(matches.flatMap((m) => m.keys))].filter((k) => !ZOTERO_KEY.test(k));
  if (invalidKeys.length > 0) {
    throw new Error(
      `Invalid Zotero item key(s) in <zcite>: ${invalidKeys.join(", ")} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ)`
    );
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

  // 4c. Same rule as inject_citations: a cited key missing from metadata.json fails, nothing is written
  const missingKeys = [...new Set(matches.flatMap((m) => m.keys))].filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    throw new Error(`${missingKeys.length} cited key(s) not found in the metadata: ${missingKeys.join(", ")}`);
  }

  // 5. Replace each zcite tag with a field code
  let injected = 0;
  for (const match of matches) {
    const citationItems = buildCitationItems(match, cslData, libraryPath);
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

  // 6. Append bibliography before </w:body>
  const biblXml = generateBibliographyFieldCode();
  documentXml = documentXml.replace("</w:body>", `${biblXml}</w:body>`);

  // 7. Document preferences (style, field type) for Zotero, then write the output .docx
  zip.file("word/document.xml", documentXml);
  const prefs = await writeZoteroDocumentPrefs(zip, style);
  if (prefs === "kept") console.error(`WARNING: ${EXISTING_PREFS_WARNING}`);
  if (prefs === "skipped") console.error(`WARNING: ${PREFS_NOT_WRITTEN_WARNING}`);
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
