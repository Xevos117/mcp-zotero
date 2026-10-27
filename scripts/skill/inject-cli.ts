// Standalone citation injection script for Claude skill usage. GENERATED from this source by
// `npm run build:skill` into skills/zotero-skill-mcp-integrations/scripts/inject.js — do not edit the
// generated file by hand.
//
// Reads a .docx (or .odt) with <zcite> tags and a metadata.json, injects Zotero citations.
//
// Usage: node inject.js <input> <output> <metadata.json> <userId|libraryPath> [style] [--format docx|odt]
//
// <libraryPath> is "users/<id>" or "groups/<id>" (library_path from get_user_id); a bare numeric ID is
// treated as a user ID for backward compatibility. The injection logic (normalizer, field codes, document
// preferences, format writers) is shared with the MCP server via src/citation-injector; only the
// metadata.json → CSL conversion (metadataToCsl) lives here, since it reads get_items_details output.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import JSZip from "jszip";
import { writeFileAtomic } from "../../src/utils/atomic-write.js";
import { parseZciteTags } from "../../src/citation-injector/zcite.js";
import { parsePandocCitesInBody, countPandocMarkers } from "../../src/citation-injector/pandoc-body.js";
import { CitekeyLookup, itemMatchesCitekey, resolveCitekeys } from "../../src/citation-injector/citekey-resolver.js";
import { assignNumbers } from "../../src/cited-document/number.js";
import { buildCitationItems } from "../../src/citation-injector/citation-json.js";
import { formatCitationText } from "../../src/citation-injector/citation-formatter.js";
import { CitationRequest, PreparedCitation } from "../../src/citation-injector/model.js";
import { FormatWriter } from "../../src/citation-injector/formats/types.js";
import { docxWriter } from "../../src/citation-injector/formats/docx.js";
import { odtWriter } from "../../src/citation-injector/formats/odt.js";
import { CslItemData } from "../../src/types/csl-types.js";

// Same rule as ZOTERO_KEY in src/utils/zotero-keys.ts (inlined to keep zod out of the skill bundle)
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/** Scrittori per formato: Word (docx) e LibreOffice (odt). */
const WRITERS: Record<string, FormatWriter> = { docx: docxWriter, odt: odtWriter };

// ---------------------------------------------------------------------------
// Zotero itemType → CSL mapping (same tables as src/utils/csl-to-zotero.ts)
// ---------------------------------------------------------------------------

const ZOTERO_TO_CSL_TYPE: Record<string, string> = {
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

const CONTAINER_TITLE_FIELD: Record<string, string> = {
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

const CSL_NAME_CREATOR_TYPES: Array<[string, string]> = [
  ["author", "author"],
  ["editor", "editor"],
  ["container-author", "bookAuthor"],
  ["collection-editor", "seriesEditor"],
  ["translator", "translator"],
];

// ---------------------------------------------------------------------------
// Metadata conversion: get_items_details JSON → CSL-JSON (kept in the CLI)
// ---------------------------------------------------------------------------

type Meta = Record<string, any>;

/** "John Smith, Jane Doe" → CslName[]; the last word is `family`, the rest `given`. */
function parseAuthors(authorString: string | undefined): Array<{ family: string; given: string }> {
  if (!authorString || authorString === "No authors listed") return [];
  return authorString.split(",").map((name) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return { family: parts[0], given: "" };
    const family = parts[parts.length - 1];
    const given = parts.slice(0, -1).join(" ");
    return { family, given };
  });
}

/** "2017", "2017-03-15" → date-parts; anything else → raw (same rule as cslDate in csl-to-zotero.ts). */
function parseDate(dateString: string | undefined): Record<string, unknown> | undefined {
  if (!dateString) return undefined;
  const parts = dateString.split("-").map(Number).filter((n) => !isNaN(n));
  if (parts.length === 0) return { raw: dateString };
  return { "date-parts": [parts] };
}

/** CSL names from structured `creators` by role (a single-field name, e.g. an institution, is a `literal`). */
function namesFromCreators(creators: Array<Record<string, string>>): Record<string, Array<Record<string, string>>> {
  const names: Record<string, Array<Record<string, string>>> = {};
  for (const [variable, creatorType] of CSL_NAME_CREATOR_TYPES) {
    const list = creators
      .filter((c) => c.creatorType === creatorType)
      .map((c) => (c.name && !c.lastName ? { literal: c.name } : { family: c.lastName ?? "", given: c.firstName ?? "" }));
    if (list.length > 0) names[variable] = list;
  }
  return names;
}

function metadataToCsl(meta: Meta): Record<string, unknown> {
  const cslType = ZOTERO_TO_CSL_TYPE[meta.itemType] ?? "article-journal";
  const authors = parseAuthors(meta.authors);
  const names = Array.isArray(meta.creators)
    ? namesFromCreators(meta.creators)
    : authors.length > 0
      ? { author: authors }
      : {};
  const issued = parseDate(meta.date);

  const csl: Record<string, unknown> = { type: cslType };

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
  const accessed = typeof meta.accessDate === "string" ? parseDate(meta.accessDate.replace(/[T ].*$/, "")) : undefined;
  if (accessed) csl.accessed = accessed;
  if (meta.ISBN) csl.ISBN = meta.ISBN;
  if (meta.ISSN) csl.ISSN = meta.ISSN;
  if (meta.edition) csl.edition = meta.edition;
  if (meta.language) csl.language = meta.language;
  if (meta.numPages) csl["number-of-pages"] = meta.numPages;

  return csl;
}

/** Full metadata object → Map<itemKey, CslItemData> (skips get_items_details' not_found array). */
function convertMetadataToCsl(metadata: Record<string, unknown>): Map<string, CslItemData> {
  const map = new Map<string, CslItemData>();
  for (const [key, meta] of Object.entries(metadata)) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    map.set(key, metadataToCsl(meta as Meta) as CslItemData);
  }
  return map;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const STYLES = ["apa", "ieee", "vancouver", "harvard", "chicago"];
const USAGE = "Usage: node inject.js <input.docx> <output.docx> <metadata.json> <userId|libraryPath> [style] [--format docx|odt]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let formatFlag: string | undefined;
  const positional: string[] = [];
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

  const extFormat = outputPath.toLowerCase().endsWith(".odt")
    ? "odt"
    : outputPath.toLowerCase().endsWith(".docx")
      ? "docx"
      : undefined;
  if (formatFlag && extFormat && formatFlag !== extFormat) {
    fail(`--format '${formatFlag}' does not match the output extension '${outputPath}'`);
  }
  const format = formatFlag ?? extFormat ?? "docx";
  if (!WRITERS[format]) fail(`Unsupported format '${format}': expected one of ${Object.keys(WRITERS).join(", ")}`);

  return { inputPath, outputPath, metadataPath, libraryPath, style, format };
}

/** True if input and output resolve to the same file (by path, or by dev/ino when both exist). */
async function sameFile(inputPath: string, outputPath: string): Promise<boolean> {
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
  const [libraryType] = libraryPath.split("/"); // "users" | "groups"
  const userId = libraryPath.split("/")[1];
  const libType = libraryType.replace(/s$/, ""); // buildCitationItems adds the trailing "s"

  const fileBuffer = await readFile(inputPath);
  const zip = await JSZip.loadAsync(fileBuffer);

  writer.sniff?.(zip); // mismatch di formato (docx vs odt): messaggio chiaro
  const bodyEntry = zip.file(writer.bodyPart);
  if (!bodyEntry) throw new Error(`Invalid ${format === "odt" ? ".odt" : ".docx"} file: ${writer.bodyPart} not found`);

  const rawBody = await bodyEntry.async("string");
  const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
  const cslData = convertMetadataToCsl(metadata);

  // Internal recognition, mirror of the server: a document with <zcite> takes the zcite path (unchanged);
  // otherwise the Pandoc branch runs. Keeps the skill output in parity with inject_citations.
  const out = rawBody.includes("zcite")
    ? await injectZcite(zip, writer, rawBody, cslData, libType, userId, style)
    : await injectPandoc(zip, writer, rawBody, cslData, metadataCitekeyLookup(metadata), libType, userId, style);

  if (writer.finalize) await writer.finalize(zip);
  const buffer = await zip.generateAsync({ type: "nodebuffer", ...writer.generateOptions });
  await writeFileAtomic(outputPath, buffer);

  for (const w of out.warnings) console.error(`WARNING: ${w}`);
  console.log(JSON.stringify({ output: outputPath, found: out.found, injected: out.injected }));
}

interface InjectOutcome {
  found: number;
  injected: number;
  warnings: string[];
}

/** The zcite path: identical to before, plus a note when the document also carries Pandoc markers. */
async function injectZcite(
  zip: JSZip,
  writer: FormatWriter,
  rawBody: string,
  cslData: Map<string, CslItemData>,
  libType: string,
  userId: string,
  style: string
): Promise<InjectOutcome> {
  let body = writer.normalize(rawBody);
  const requests = parseZciteTags(body);
  if (requests.length === 0) {
    return { found: 0, injected: 0, warnings: [] };
  }

  const allKeys = [...new Set(requests.flatMap((r) => r.keys))];
  const invalidKeys = allKeys.filter((k) => !ZOTERO_KEY.test(k));
  if (invalidKeys.length > 0) {
    throw new Error(
      `Invalid Zotero item key(s) in <zcite>: ${invalidKeys.join(", ")} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ)`
    );
  }

  const warnings: string[] = [];
  if (style === "ieee" || style === "vancouver") {
    const withNum = requests.filter((r) => r.num !== undefined).length;
    if (withNum < requests.length) {
      warnings.push(`Style '${style}' requires 'num' attribute on <zcite> tags. Found ${withNum}/${requests.length} tags with num.`);
    }
  }

  const missingKeys = allKeys.filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    throw new Error(`${missingKeys.length} cited key(s) not found in the metadata: ${missingKeys.join(", ")}`);
  }

  const injected = injectRequests(writer, requests, cslData, libType, userId, style, (b) => (body = b), () => body);

  body = writer.appendBibliography(body);
  zip.file(writer.bodyPart, body);

  const prefs = await writer.writePrefs(zip, style);
  warnings.push(...writer.prefsWarnings(prefs));

  const pandoc = countPandocMarkers(rawBody);
  if (pandoc > 0) {
    warnings.push(
      `The document also has ${pandoc} Pandoc citation marker(s) ([@key]): left as text, because a document with <zcite> ` +
        "is treated as a zcite document. To cite them too, run inject again on the output."
    );
  }

  return { found: requests.length, injected, warnings };
}

/** The Pandoc path: parse markers, resolve Better BibTeX citekeys from the metadata, reuse the writer. */
async function injectPandoc(
  zip: JSZip,
  writer: FormatWriter,
  rawBody: string,
  cslData: Map<string, CslItemData>,
  citekeyLookup: CitekeyLookup,
  libType: string,
  userId: string,
  style: string
): Promise<InjectOutcome> {
  let body = writer.normalizePandoc ? writer.normalizePandoc(rawBody) : rawBody;
  const parsed = parsePandocCitesInBody(body);
  if (parsed.length === 0) {
    return { found: 0, injected: 0, warnings: [] };
  }

  const requests = await resolveCitekeys(parsed, citekeyLookup);

  if (style === "ieee" || style === "vancouver") {
    const nums = assignNumbers(requests);
    for (const r of requests) r.num = nums.get(r);
  }

  const missingKeys = [...new Set(requests.flatMap((r) => r.keys))].filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    throw new Error(`${missingKeys.length} cited key(s) not found in the metadata: ${missingKeys.join(", ")}`);
  }

  // Longer markers first (an inline `@KEY` is a substring of `-@KEY` / a longer citekey); see pipeline.ts.
  const ordered = [...requests].sort((a, b) => b.raw.length - a.raw.length);
  const injected = injectRequests(writer, ordered, cslData, libType, userId, style, (b) => (body = b), () => body);

  const warnings: string[] = [];
  if (body.includes("ZOTERO_BIBL")) {
    warnings.push("The document already has a Zotero bibliography: no second one was written.");
  } else {
    body = writer.appendBibliography(body);
  }
  zip.file(writer.bodyPart, body);

  const prefs = await writer.writePrefs(zip, style);
  warnings.push(...writer.prefsWarnings(prefs));

  return { found: parsed.length, injected, warnings };
}

/** Replace each request's marker with its citation XML; returns how many were injected. */
function injectRequests(
  writer: FormatWriter,
  requests: CitationRequest[],
  cslData: Map<string, CslItemData>,
  libType: string,
  userId: string,
  style: string,
  setBody: (b: string) => void,
  getBody: () => string
): number {
  let injected = 0;
  for (const request of requests) {
    const items = buildCitationItems(request, cslData, libType, userId);
    const itemData = request.keys.map((k) => cslData.get(k) ?? { type: "article-journal" });
    const formattedText = formatCitationText(itemData, style, request);
    const prepared: PreparedCitation = { request, items, itemData, formattedText };
    const body = getBody();
    const newBody = writer.replaceTag(body, request.raw, writer.citationXml(prepared));
    if (newBody !== body) {
      setBody(newBody);
      injected++;
    }
  }
  return injected;
}

/** Build a citekey→Zotero-key lookup from the get_items_details metadata (citationKey field or Extra line). */
function metadataCitekeyLookup(metadata: Record<string, unknown>): CitekeyLookup {
  return async (citekeys) => {
    const out = new Map<string, string[]>();
    for (const ck of citekeys) {
      const keys: string[] = [];
      for (const [key, meta] of Object.entries(metadata)) {
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
        if (itemMatchesCitekey(meta as Record<string, unknown>, ck)) keys.push(key);
      }
      out.set(ck, [...new Set(keys)]);
    }
    return out;
  };
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
