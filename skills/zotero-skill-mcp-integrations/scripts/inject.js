#!/usr/bin/env node
// GENERATED — npm run build:skill (sorgente: scripts/skill/inject-cli.ts). Non modificare a mano.


// scripts/skill/inject-cli.ts
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

// runtime-dep:jszip
var _N = "jszip,node:module".split(",");
var _JSZip;
try {
  _JSZip = (await import(_N[0])).default;
} catch {
  const _m = await import(_N[1]);
  _JSZip = _m.createRequire(process.cwd() + "/package.json")("jszip");
}
var jszip_default = _JSZip;

// src/utils/atomic-write.ts
import { open, rename, unlink, link, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
async function writeFileAtomic(path, data, opts = {}) {
  const overwrite = opts.overwrite ?? true;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let tmpExists = false;
  try {
    const fh = await open(tmp, "wx");
    tmpExists = true;
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (overwrite) {
      await rename(tmp, path);
      tmpExists = false;
      return;
    }
    try {
      await link(tmp, path);
    } catch (err) {
      const code = err.code;
      if (code === "EEXIST") throw err;
      if (code === "ENOSYS" || code === "EPERM" || code === "EXDEV" || code === "EOPNOTSUPP") {
        await copyFile(tmp, path, constants.COPYFILE_EXCL);
      } else {
        throw err;
      }
    }
  } finally {
    if (tmpExists) {
      try {
        await unlink(tmp);
      } catch {
      }
    }
  }
}

// src/citation-injector/xml-utils.ts
function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function unescapeXml(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function regexEscape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/citation-injector/zcite.ts
function parseZciteTags(documentXml) {
  const findRegex = /&lt;zcite\s+[\s\S]*?\/&gt;/g;
  const requests = [];
  let findMatch;
  while ((findMatch = findRegex.exec(documentXml)) !== null) {
    const fullMatch = findMatch[0];
    const cleanTag = unescapeXml(fullMatch);
    const attrRegex = /(\w+)="([^"]*)"/g;
    const attrs = {};
    let attrMatch;
    while ((attrMatch = attrRegex.exec(cleanTag)) !== null) {
      attrs[attrMatch[1]] = unescapeXml(attrMatch[2]);
    }
    const keys = (attrs["keys"] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) continue;
    requests.push({
      raw: fullMatch,
      keys,
      locator: attrs["locator"] || void 0,
      prefix: attrs["prefix"] || void 0,
      suffix: attrs["suffix"] || void 0,
      num: attrs["num"] || void 0
    });
  }
  return requests;
}

// src/citation-injector/citation-json.ts
import { randomUUID } from "node:crypto";
var CSL_SCHEMA_URL = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";
function buildCitationItems(request, cslData, libraryType, userId) {
  return request.keys.map((key, idx) => {
    const itemData = cslData.get(key) ?? { type: "article-journal" };
    const uri = `http://zotero.org/${libraryType}s/${userId}/items/${key}`;
    const item = {
      id: idx,
      uris: [uri],
      uri: [uri],
      itemData
    };
    if (request.locator) item.locator = request.locator;
    if (request.prefix) item.prefix = request.prefix;
    if (request.suffix) item.suffix = request.suffix;
    return item;
  });
}
function buildCslCitation(citationItems, formattedText) {
  return {
    citationID: randomUUID().slice(0, 8),
    properties: { formattedCitation: formattedText },
    citationItems,
    schema: CSL_SCHEMA_URL
  };
}

// src/citation-injector/citation-formatter.ts
var AUTHOR_DATE = {
  apa: { yearSep: ", ", and: "&", pageLabel: true },
  harvard: { yearSep: ", ", and: "and", pageLabel: true },
  chicago: { yearSep: " ", and: "and", pageLabel: false }
};
function formatLocator(locator, pageLabel) {
  const bare = locator.trim().replace(/^pp?\.\s*/i, "");
  if (!/^[\divxlcdm]/i.test(bare) || /^[a-z]{2,}\.?\s/i.test(bare)) return locator.trim();
  const pages = bare.replace(/(\d)\s*-+\s*(\d)/g, "$1\u2013$2");
  if (!pageLabel) return pages;
  return `${/[–,&]/.test(pages) ? "pp." : "p."} ${pages}`;
}
function affixes(opts) {
  const prefix = opts.prefix?.trim() ? `${opts.prefix.trim()} ` : "";
  const s = opts.suffix?.trim() ?? "";
  const suffix = !s ? "" : /^[,;.:)\]]/.test(s) ? s : ` ${s}`;
  return { prefix, suffix };
}
function numbersPerItem(num, count) {
  const out = [];
  for (const part of num.split(",").map((p) => p.trim())) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(String(n));
    else out.push(part);
  }
  return out.length === count ? out : void 0;
}
function numberedText(count, style, opts) {
  const num = opts.num ?? "?";
  const { prefix, suffix } = affixes(opts);
  const locator = opts.locator && style === "ieee" ? `, ${formatLocator(opts.locator, true)}` : "";
  if (!prefix && !suffix && !locator) return `[${num}]`;
  const perItem = numbersPerItem(num, count) ?? [num];
  if (style === "ieee") return perItem.map((n) => `${prefix}[${n}${locator}]${suffix}`).join(", ");
  return `[${perItem.map((n) => `${prefix}${n}${suffix}`).join(",")}]`;
}
function formatCitationText(items, style, opts = {}) {
  if (style === "ieee" || style === "vancouver") {
    return numberedText(items.length, style, opts);
  }
  const rules = AUTHOR_DATE[style] ?? AUTHOR_DATE.apa;
  const { prefix, suffix } = affixes(opts);
  const locator = opts.locator ? `, ${formatLocator(opts.locator, rules.pageLabel)}` : "";
  const parts = items.map((item) => {
    const authors = item.author;
    const name = (a) => a.family ?? a.literal ?? "Unknown";
    const year = item.issued?.["date-parts"]?.[0]?.[0]?.toString() ?? "n.d.";
    let authorText;
    if (!authors || authors.length === 0) {
      const title = item.title;
      authorText = title ? title.length > 30 ? `"${title.substring(0, 30)}..."` : `"${title}"` : "Unknown";
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

// src/citation-injector/model.ts
var InjectionError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "InjectionError";
  }
  code;
};

// runtime-dep:fast-xml-parser
var _N2 = "fast-xml-parser,node:module".split(",");
var _fxp;
try {
  _fxp = await import(_N2[0]);
} catch {
  const _m = await import(_N2[1]);
  _fxp = _m.createRequire(process.cwd() + "/package.json")("fast-xml-parser");
}
var XMLParser = _fxp.XMLParser;
var XMLBuilder = _fxp.XMLBuilder;

// src/citation-injector/zcite-normalizer.ts
var ZCITE_PATTERN = /&lt;zcite\s+[\s\S]*?\/&gt;/;
var PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
  // Prevent fast-xml-parser from parsing numeric/boolean text
  parseTagValue: false,
  parseAttributeValue: false
};
var BUILDER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  format: false,
  suppressEmptyNode: false,
  suppressBooleanAttributes: false
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
    ":@": { "@_xml:space": "preserve" }
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
function normalizeZciteTags(documentXml) {
  if (!documentXml.includes("zcite")) {
    return documentXml;
  }
  const parser = new XMLParser(PARSER_OPTIONS);
  const parsed = parser.parse(documentXml);
  const modified = walkAndNormalize(parsed);
  if (!modified) {
    return documentXml;
  }
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  return builder.build(parsed);
}

// src/citation-injector/field-codes.ts
function generateZoteroFieldCode(citationItems, formattedText) {
  const cslCitation = buildCslCitation(citationItems, formattedText);
  const instrText = ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(cslCitation)} `;
  const escapedInstrText = escapeXml(instrText);
  return [
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    `<w:r><w:instrText xml:space="preserve">${escapedInstrText}</w:instrText></w:r>`,
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r><w:rPr><w:noProof/></w:rPr><w:t>${escapeXml(formattedText)}</w:t></w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  ].join("");
}
function generateBibliographyFieldCode() {
  return [
    "<w:p>",
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    '<w:r><w:instrText xml:space="preserve">',
    " ADDIN ZOTERO_BIBL {&quot;uncited&quot;:[],&quot;omitted&quot;:[],&quot;custom&quot;:[]} CSL_BIBLIOGRAPHY ",
    "</w:instrText></w:r>",
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    "<w:r><w:rPr><w:noProof/></w:rPr><w:t>[Bibliography will be generated by Zotero]</w:t></w:r>",
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
    "</w:p>"
  ].join("");
}

// src/citation-injector/document-prefs.ts
import { randomBytes as randomBytes2 } from "node:crypto";
var ZOTERO_STYLE_IDS = {
  apa: "http://www.zotero.org/styles/apa",
  ieee: "http://www.zotero.org/styles/ieee",
  vancouver: "http://www.zotero.org/styles/nlm-citation-sequence",
  harvard: "http://www.zotero.org/styles/harvard-cite-them-right",
  chicago: "http://www.zotero.org/styles/chicago-author-date"
};
var CUSTOM_PART = "docProps/custom.xml";
var CUSTOM_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml";
var CUSTOM_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
var FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
var PREF_CHUNK = 255;
var SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
var escapeXml2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function sessionId() {
  return [...randomBytes2(8)].map((b) => SESSION_ALPHABET[b % SESSION_ALPHABET.length]).join("");
}
function zoteroDocumentData(styleId, fieldType = "Field", session = sessionId()) {
  return `<data data-version="3"><session id="${session}"/><style id="${escapeXml2(styleId)}" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/><prefs><pref name="fieldType" value="${fieldType}"/></prefs></data>`;
}
function prefChunks(value) {
  const out = [];
  for (let i = 0; i < value.length; i += PREF_CHUNK) out.push(value.slice(i, i + PREF_CHUNK));
  return out;
}
var EXISTING_PREFS_WARNING = "The document already has Zotero document preferences (ZOTERO_PREF_* in docProps/custom.xml): kept as they are, so on the first Refresh Zotero uses the style saved there, not the style of this injection.";
var PREFS_NOT_WRITTEN_WARNING = "Zotero document preferences not written: the document's custom properties part could not be merged into, so Zotero may ask for the document style (Document Preferences) on the first Refresh.";
function customPartName(rels) {
  for (const m of (rels ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    if (!m[0].includes(CUSTOM_REL_TYPE)) continue;
    const target = /\bTarget=["']([^"']+)["']/.exec(m[0])?.[1];
    if (target) return target.replace(/^\/+/, "");
  }
  return CUSTOM_PART;
}
async function writeZoteroDocumentPrefs(zip, style) {
  const styleId = ZOTERO_STYLE_IDS[style];
  if (!styleId) return "skipped";
  const rels = await zip.file("_rels/.rels")?.async("string");
  const part = customPartName(rels);
  const existing = await zip.file(part)?.async("string");
  if (existing && /\bname=["']ZOTERO_PREF_\d+["']/.test(existing)) return "kept";
  const pids = [...(existing ?? "").matchAll(/\bpid=["'](\d+)["']/g)].map((m) => Number(m[1]));
  let pid = Math.max(1, ...pids);
  const root = existing ? /<(\w+:)?Properties\b([^>]*?)(\/?)>/.exec(existing) : null;
  const prefix = root?.[1] ?? "";
  const properties = prefChunks(zoteroDocumentData(styleId)).map((chunk, i) => `<${prefix}property fmtid="${FMTID}" pid="${++pid}" name="ZOTERO_PREF_${i + 1}"><vt:lpwstr>${escapeXml2(chunk)}</vt:lpwstr></${prefix}property>`).join("");
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
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${properties}</Properties>`
    );
  }
  const typesEntry = zip.file("[Content_Types].xml");
  if (typesEntry) {
    const types = await typesEntry.async("string");
    if (!types.includes(`PartName="/${part}"`)) {
      zip.file("[Content_Types].xml", types.replace("</Types>", `<Override PartName="/${part}" ContentType="${CUSTOM_CONTENT_TYPE}"/></Types>`));
    }
  }
  if (rels !== void 0 && !rels.includes(CUSTOM_REL_TYPE)) {
    const ids = new Set([...rels.matchAll(/\bId=["']([^"']+)["']/g)].map((m) => m[1]));
    let n = 1;
    while (ids.has(`rId${n}`)) n++;
    zip.file("_rels/.rels", rels.replace("</Relationships>", `<Relationship Id="rId${n}" Type="${CUSTOM_REL_TYPE}" Target="${part}"/></Relationships>`));
  }
  return "written";
}

// src/citation-injector/formats/docx.ts
var REGENERATE_DOCX = "The file is not a Word document or is corrupted: create it again as .docx (e.g. with the docx npm package) and call again.";
function replaceZciteInXml(xml, escapedZciteTag, fieldCodeXml) {
  const soloRunRegex = new RegExp(
    `<w:r[^>]*>(?:<w:rPr>[^<]*(?:<(?!/w:rPr>)[^<]*)*</w:rPr>)?<w:t[^>]*>${regexEscape(escapedZciteTag)}</w:t></w:r>`
  );
  if (soloRunRegex.test(xml)) {
    return xml.replace(soloRunRegex, fieldCodeXml);
  }
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
var docxWriter = {
  format: "docx",
  fieldType: "Field",
  bodyPart: "word/document.xml",
  app: "Word",
  invalidPackageMessage: (detail) => `Invalid .docx file: not a readable ZIP archive (${detail}). ${REGENERATE_DOCX}`,
  bodyMissingMessage: `Invalid .docx file: word/document.xml not found. ${REGENERATE_DOCX}`,
  sniff(zip) {
    if (zip.file("content.xml") && !zip.file("word/document.xml")) {
      throw new InjectionError("format_mismatch", 'This looks like a LibreOffice .odt, not a Word .docx. Use format "odt" (or a .odt file).');
    }
  },
  normalize: (bodyXml) => normalizeZciteTags(bodyXml),
  citationXml: (prepared) => generateZoteroFieldCode(prepared.items, prepared.formattedText),
  replaceTag: (bodyXml, rawTag, citationXml2) => replaceZciteInXml(bodyXml, rawTag, citationXml2),
  appendBibliography: (bodyXml) => bodyXml.replace("</w:body>", `${generateBibliographyFieldCode()}</w:body>`),
  writePrefs: (zip, style) => writeZoteroDocumentPrefs(zip, style),
  prefsWarnings: (outcome) => {
    if (outcome === "kept") return [EXISTING_PREFS_WARNING];
    if (outcome === "skipped") return [PREFS_NOT_WRITTEN_WARNING];
    return [];
  },
  async skeleton() {
    const zip = new jszip_default();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    );
    zip.file(
      "word/document.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:sectPr/></w:body></w:document>'
    );
    return zip;
  }
};

// src/citation-injector/formats/odt.ts
import { randomBytes as randomBytes3 } from "node:crypto";

// src/citation-injector/odt-normalizer.ts
var ZCITE_PATTERN2 = /&lt;zcite\s+[\s\S]*?\/&gt;/;
var PARSER_OPTIONS2 = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
};
var BUILDER_OPTIONS2 = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  format: false,
  suppressEmptyNode: false,
  suppressBooleanAttributes: false
};
var MASKED = /* @__PURE__ */ new Set(["office:annotation", "text:note"]);
function extractSpanText(spanChildren) {
  let text = "";
  for (const child of spanChildren) {
    if ("#text" in child) text += String(child["#text"]);
    else if ("text:s" in child) {
      const c = Number(child[":@"]?.["@_text:c"] ?? "1");
      text += " ".repeat(Number.isFinite(c) && c > 0 ? c : 1);
    }
  }
  return text;
}
function isSpan(node) {
  return "text:span" in node;
}
function spanHasText(spanChildren) {
  return spanChildren.some((c) => "#text" in c || "text:s" in c);
}
function collectConsecutiveSpanGroups(children) {
  const groups = [];
  let current = null;
  const flush = () => {
    if (current && current.texts.length >= 2) groups.push(current);
    current = null;
  };
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isSpan(child) && spanHasText(child["text:span"])) {
      const text = extractSpanText(child["text:span"]);
      if (current) {
        current.endIndex = i;
        current.texts.push(text);
      } else {
        current = { startIndex: i, endIndex: i, texts: [text] };
      }
      continue;
    }
    flush();
  }
  flush();
  return groups;
}
function findSplitZcite2(group) {
  const { texts } = group;
  for (let start = 0; start < texts.length; start++) {
    let concat = "";
    for (let end = start; end < texts.length; end++) {
      concat += texts[end];
      if (end <= start) continue;
      const m = ZCITE_PATTERN2.exec(concat);
      if (m) {
        const matchStart = m.index;
        const matchEnd = m.index + m[0].length;
        const lastStart = concat.length - texts[end].length;
        if (matchStart < lastStart && matchEnd > lastStart) return { startOffset: start, endOffset: end };
      }
    }
  }
  return null;
}
function mergeSpansInPlace(children, group, startOffset, endOffset) {
  const absStart = group.startIndex + startOffset;
  const absEnd = group.startIndex + endOffset;
  const count = absEnd - absStart + 1;
  let merged = "";
  for (let i = absStart; i <= absEnd; i++) merged += extractSpanText(children[i]["text:span"]);
  const newSpan = { "text:span": [{ "#text": merged }] };
  const firstAttrs = children[absStart][":@"];
  if (firstAttrs) newSpan[":@"] = firstAttrs;
  children.splice(absStart, count, newSpan);
}
function normalizeParagraph(children) {
  let modified = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of collectConsecutiveSpanGroups(children)) {
      const split = findSplitZcite2(group);
      if (split) {
        mergeSpansInPlace(children, group, split.startOffset, split.endOffset);
        modified = true;
        changed = true;
        break;
      }
    }
  }
  return modified;
}
function walk(nodes) {
  let modified = false;
  for (const node of nodes) {
    const tag = Object.keys(node).find((k) => k !== ":@" && k !== "#text");
    if (tag && MASKED.has(tag)) continue;
    if (tag === "text:p" || tag === "text:h") {
      if (normalizeParagraph(node[tag])) modified = true;
    }
    for (const key of Object.keys(node)) {
      if (key === ":@" || key === "#text") continue;
      const value = node[key];
      if (Array.isArray(value) && walk(value)) modified = true;
    }
  }
  return modified;
}
function normalizeOdtZciteTags(contentXml) {
  if (!contentXml.includes("zcite")) return contentXml;
  const parsed = new XMLParser(PARSER_OPTIONS2).parse(contentXml);
  if (!walk(parsed)) return contentXml;
  return new XMLBuilder(BUILDER_OPTIONS2).build(parsed);
}

// src/citation-injector/formats/odt.ts
var ODT_MIME = "application/vnd.oasis.opendocument.text";
var REGENERATE_ODT = "The file is not a LibreOffice document or is corrupted: create it again as .odt and call again.";
var RND_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function rnd10() {
  return [...randomBytes3(10)].map((b) => RND_ALPHABET[b % RND_ALPHABET.length]).join("");
}
function citationXml(prepared) {
  const csl = buildCslCitation(prepared.items, prepared.formattedText);
  const name = escapeXml(`ZOTERO_ITEM CSL_CITATION ${JSON.stringify(csl)} RND${rnd10()}`);
  return `<text:reference-mark-start text:name="${name}"/>` + escapeXml(prepared.formattedText) + `<text:reference-mark-end text:name="${name}"/>`;
}
function appendBibliography(contentXml) {
  const name = escapeXml(`ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY RND${rnd10()}`);
  const section = `<text:section text:name="${name}"><text:p text:style-name="Bibliography_20_1">[Bibliography will be generated by Zotero]</text:p></text:section><text:p/>`;
  return contentXml.replace("</office:text>", `${section}</office:text>`);
}
var BIBLIOGRAPHY_STYLE = '<style:style style:name="Bibliography_20_1" style:display-name="Bibliography 1" style:family="paragraph" style:parent-style-name="Standard" style:class="list"/>';
async function ensureBibliographyStyle(zip) {
  const entry = zip.file("styles.xml");
  if (!entry) return;
  let styles = await entry.async("string");
  if (styles.includes('style:name="Bibliography_20_1"')) return;
  if (styles.includes("</office:styles>")) {
    styles = styles.replace("</office:styles>", `${BIBLIOGRAPHY_STYLE}</office:styles>`);
  } else if (/<office:styles\s*\/>/.test(styles)) {
    styles = styles.replace(/<office:styles\s*\/>/, `<office:styles>${BIBLIOGRAPHY_STYLE}</office:styles>`);
  } else {
    return;
  }
  zip.file("styles.xml", styles);
}
var EXISTING_ODT_PREFS_WARNING = "The document already has Zotero document preferences (ZOTERO_PREF_* in meta.xml): kept as they are, so on the first Refresh Zotero uses the style saved there, not the style of this injection.";
var ODT_PREFS_NOT_WRITTEN_WARNING = "Zotero document preferences not written: meta.xml has no <office:meta> to merge into, so Zotero may ask for the document style (Document Preferences) on the first Refresh.";
async function writeOdtPrefs(zip, style) {
  const styleId = ZOTERO_STYLE_IDS[style];
  if (!styleId) return "skipped";
  const entry = zip.file("meta.xml");
  const meta = entry ? await entry.async("string") : void 0;
  if (meta === void 0) return "skipped";
  if (/\bmeta:name=["']ZOTERO_PREF_\d+["']/.test(meta)) return "kept";
  const value = zoteroDocumentData(styleId, "ReferenceMark");
  const props = prefChunks(value).map((chunk, i) => `<meta:user-defined meta:name="ZOTERO_PREF_${i + 1}">${escapeXml(chunk)}</meta:user-defined>`).join("");
  const close = "</office:meta>";
  const at = meta.lastIndexOf(close);
  if (at < 0) {
    const m = /<office:meta\b([^>]*)\/>/.exec(meta);
    if (!m) return "skipped";
    zip.file("meta.xml", meta.replace(m[0], `<office:meta${m[1]}>${props}</office:meta>`));
    return "written";
  }
  zip.file("meta.xml", meta.slice(0, at) + props + meta.slice(at));
  return "written";
}
var odtWriter = {
  format: "odt",
  fieldType: "ReferenceMark",
  bodyPart: "content.xml",
  app: "LibreOffice",
  invalidPackageMessage: (detail) => `Invalid .odt file: not a readable ZIP archive (${detail}). ${REGENERATE_ODT}`,
  bodyMissingMessage: `Invalid .odt file: content.xml not found. ${REGENERATE_ODT}`,
  sniff(zip) {
    if (zip.file("word/document.xml")) {
      throw new InjectionError("format_mismatch", 'This looks like a Word .docx, not a LibreOffice .odt. Use format "docx" (or a .docx file).');
    }
  },
  normalize: (bodyXml) => normalizeOdtZciteTags(bodyXml),
  citationXml,
  replaceTag: (bodyXml, rawTag, cite) => {
    const at = bodyXml.indexOf(rawTag);
    return at < 0 ? bodyXml : bodyXml.slice(0, at) + cite + bodyXml.slice(at + rawTag.length);
  },
  appendBibliography,
  writePrefs: writeOdtPrefs,
  prefsWarnings: (outcome) => {
    if (outcome === "kept") return [EXISTING_ODT_PREFS_WARNING];
    if (outcome === "skipped") return [ODT_PREFS_NOT_WRITTEN_WARNING];
    return [];
  },
  async finalize(zip) {
    await ensureBibliographyStyle(zip);
    const mimetype = zip.file("mimetype");
    if (mimetype) zip.file("mimetype", await mimetype.async("uint8array"), { compression: "STORE" });
  },
  generateOptions: { compression: "DEFLATE" },
  async skeleton() {
    const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';
    const zip = new jszip_default();
    zip.file("mimetype", ODT_MIME, { compression: "STORE" });
    zip.file(
      "META-INF/manifest.xml",
      `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${ODT_MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>`
    );
    zip.file(
      "content.xml",
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:automatic-styles><style:style style:name="T_Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style><style:style style:name="T_Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style></office:automatic-styles><office:body><office:text></office:text></office:body></office:document-content>`
    );
    zip.file("styles.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:styles/></office:document-styles>`);
    zip.file("meta.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}><office:meta/></office:document-meta>`);
    return zip;
  }
};

// scripts/skill/inject-cli.ts
var ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;
var WRITERS = { docx: docxWriter, odt: odtWriter };
var ZOTERO_TO_CSL_TYPE = {
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
  instantMessage: "personal_communication"
};
var CONTAINER_TITLE_FIELD = {
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
  podcast: "programTitle"
};
var CSL_NAME_CREATOR_TYPES = [
  ["author", "author"],
  ["editor", "editor"],
  ["container-author", "bookAuthor"],
  ["collection-editor", "seriesEditor"],
  ["translator", "translator"]
];
function parseAuthors(authorString) {
  if (!authorString || authorString === "No authors listed") return [];
  return authorString.split(",").map((name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { family: parts[0], given: "" };
    const family = parts[parts.length - 1];
    const given = parts.slice(0, -1).join(" ");
    return { family, given };
  });
}
function parseDate(dateString) {
  if (!dateString) return void 0;
  const parts = dateString.split("-").map(Number).filter((n) => !isNaN(n));
  if (parts.length === 0) return { raw: dateString };
  return { "date-parts": [parts] };
}
function namesFromCreators(creators) {
  const names = {};
  for (const [variable, creatorType] of CSL_NAME_CREATOR_TYPES) {
    const list = creators.filter((c) => c.creatorType === creatorType).map((c) => c.name && !c.lastName ? { literal: c.name } : { family: c.lastName ?? "", given: c.firstName ?? "" });
    if (list.length > 0) names[variable] = list;
  }
  return names;
}
function metadataToCsl(meta) {
  const cslType = ZOTERO_TO_CSL_TYPE[meta.itemType] ?? "article-journal";
  const authors = parseAuthors(meta.authors);
  const names = Array.isArray(meta.creators) ? namesFromCreators(meta.creators) : authors.length > 0 ? { author: authors } : {};
  const issued = parseDate(meta.date);
  const csl = { type: cslType };
  if (meta.title) csl.title = meta.title;
  Object.assign(csl, names);
  if (issued) csl.issued = issued;
  if (meta.DOI || meta.doi) csl.DOI = meta.DOI || meta.doi;
  const container = meta.containerTitle || meta[CONTAINER_TITLE_FIELD[meta.itemType]] || meta.publicationTitle;
  if (container) csl["container-title"] = container;
  if (meta.volume) csl.volume = meta.volume;
  if (meta.issue) csl.issue = meta.issue;
  if (meta.page || meta.pages) csl.page = meta.page || meta.pages;
  const publisher = meta.publisher || meta.university || meta.institution || meta.repository;
  if (publisher) csl.publisher = publisher;
  if (meta.publisherPlace || meta.place) csl["publisher-place"] = meta.publisherPlace || meta.place;
  if (meta.reportNumber || meta.archiveID) csl.number = meta.reportNumber || meta.archiveID;
  if (meta.thesisType || meta.reportType) csl.genre = meta.thesisType || meta.reportType;
  if (meta.URL || meta.url) csl.URL = meta.URL || meta.url;
  const accessed = typeof meta.accessDate === "string" ? parseDate(meta.accessDate.replace(/[T ].*$/, "")) : void 0;
  if (accessed) csl.accessed = accessed;
  if (meta.ISBN) csl.ISBN = meta.ISBN;
  if (meta.ISSN) csl.ISSN = meta.ISSN;
  if (meta.edition) csl.edition = meta.edition;
  if (meta.language) csl.language = meta.language;
  if (meta.numPages) csl["number-of-pages"] = meta.numPages;
  return csl;
}
function convertMetadataToCsl(metadata) {
  const map = /* @__PURE__ */ new Map();
  for (const [key, meta] of Object.entries(metadata)) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    map.set(key, metadataToCsl(meta));
  }
  return map;
}
var STYLES = ["apa", "ieee", "vancouver", "harvard", "chicago"];
var USAGE = "Usage: node inject.js <input.docx> <output.docx> <metadata.json> <userId|libraryPath> [style] [--format docx|odt]";
function fail(message) {
  console.error(message);
  process.exit(1);
}
function parseArgs(argv) {
  let formatFlag;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") formatFlag = argv[++i];
    else if (a.startsWith("--format=")) formatFlag = a.slice("--format=".length);
    else positional.push(a);
  }
  if (positional.length < 4) fail(USAGE);
  const [inputPath, outputPath, metadataPath, libraryArg, styleArg] = positional;
  const style = styleArg ?? "apa";
  if (!STYLES.includes(style)) fail(`Invalid style '${style}': expected one of ${STYLES.join(", ")}`);
  const libraryPath = /^\d+$/.test(libraryArg) ? `users/${libraryArg}` : libraryArg;
  if (!/^(users|groups)\/\d+$/.test(libraryPath)) {
    fail(`Invalid library '${libraryArg}': expected a numeric user ID, "users/<id>" or "groups/<id>"`);
  }
  const extFormat = outputPath.toLowerCase().endsWith(".odt") ? "odt" : outputPath.toLowerCase().endsWith(".docx") ? "docx" : void 0;
  if (formatFlag && extFormat && formatFlag !== extFormat) {
    fail(`--format '${formatFlag}' does not match the output extension '${outputPath}'`);
  }
  const format = formatFlag ?? extFormat ?? "docx";
  if (!WRITERS[format]) fail(`Unsupported format '${format}': expected one of ${Object.keys(WRITERS).join(", ")}`);
  return { inputPath, outputPath, metadataPath, libraryPath, style, format };
}
async function sameFile(inputPath, outputPath) {
  if (resolve(inputPath) === resolve(outputPath)) return true;
  try {
    const [si, so] = await Promise.all([stat(inputPath), stat(outputPath)]);
    return si.dev === so.dev && si.ino === so.ino;
  } catch {
    return false;
  }
}
async function main() {
  const { inputPath, outputPath, metadataPath, libraryPath, style, format } = parseArgs(process.argv.slice(2));
  const writer = WRITERS[format];
  if (await sameFile(inputPath, outputPath)) {
    throw new Error(`Output path must differ from the input path (${outputPath})`);
  }
  const [libraryType] = libraryPath.split("/");
  const userId = libraryPath.split("/")[1];
  const libType = libraryType.replace(/s$/, "");
  const fileBuffer = await readFile(inputPath);
  const zip = await jszip_default.loadAsync(fileBuffer);
  writer.sniff?.(zip);
  const bodyEntry = zip.file(writer.bodyPart);
  if (!bodyEntry) throw new Error(`Invalid ${format === "odt" ? ".odt" : ".docx"} file: ${writer.bodyPart} not found`);
  let body = writer.normalize(await bodyEntry.async("string"));
  const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
  const cslData = convertMetadataToCsl(metadata);
  const requests = parseZciteTags(body);
  if (requests.length === 0) {
    if (writer.finalize) await writer.finalize(zip);
    const buffer2 = await zip.generateAsync({ type: "nodebuffer", ...writer.generateOptions });
    await writeFileAtomic(outputPath, buffer2);
    console.log(JSON.stringify({ output: outputPath, found: 0, injected: 0 }));
    return;
  }
  const allKeys = [...new Set(requests.flatMap((r) => r.keys))];
  const invalidKeys = allKeys.filter((k) => !ZOTERO_KEY.test(k));
  if (invalidKeys.length > 0) {
    throw new Error(
      `Invalid Zotero item key(s) in <zcite>: ${invalidKeys.join(", ")} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ)`
    );
  }
  if (style === "ieee" || style === "vancouver") {
    const withNum = requests.filter((r) => r.num !== void 0).length;
    if (withNum < requests.length) {
      console.error(`WARNING: Style '${style}' requires 'num' attribute on <zcite> tags. Found ${withNum}/${requests.length} tags with num.`);
    }
  }
  const missingKeys = allKeys.filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    throw new Error(`${missingKeys.length} cited key(s) not found in the metadata: ${missingKeys.join(", ")}`);
  }
  let injected = 0;
  for (const request of requests) {
    const items = buildCitationItems(request, cslData, libType, userId);
    const itemData = request.keys.map((k) => cslData.get(k) ?? { type: "article-journal" });
    const formattedText = formatCitationText(itemData, style, request);
    const prepared = { request, items, itemData, formattedText };
    const newBody = writer.replaceTag(body, request.raw, writer.citationXml(prepared));
    if (newBody !== body) {
      body = newBody;
      injected++;
    }
  }
  body = writer.appendBibliography(body);
  zip.file(writer.bodyPart, body);
  const prefs = await writer.writePrefs(zip, style);
  for (const w of writer.prefsWarnings(prefs)) console.error(`WARNING: ${w}`);
  if (writer.finalize) await writer.finalize(zip);
  const buffer = await zip.generateAsync({ type: "nodebuffer", ...writer.generateOptions });
  await writeFileAtomic(outputPath, buffer);
  console.log(JSON.stringify({ output: outputPath, found: requests.length, injected }));
}
main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
