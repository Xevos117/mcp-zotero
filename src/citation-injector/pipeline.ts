import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { format, parse } from "node:path";
import { CslItemData } from "../types/csl-types.js";
import { ZOTERO_KEY } from "../utils/zotero-keys.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { CitationRequest, InjectionError, PreparedCitation } from "./model.js";
import { parseZciteTags } from "./zcite.js";
import { parsePandocCitesInBody, countPandocMarkers } from "./pandoc-body.js";
import { CitekeyLookup, resolveCitekeys } from "./citekey-resolver.js";
import { assignNumbers } from "../cited-document/number.js";
import { buildCitationItems } from "./citation-json.js";
import { formatCitationText } from "./citation-formatter.js";
import { FormatWriter } from "./formats/types.js";

export interface InjectionResult {
  outputPath: string;
  found: number;
  injected: number;
  warnings: string[];
}

/** Sorgente delle voci: il server legge dall'API Zotero, la skill dal metadata.json. 404 → chiave assente. */
export type ItemSource = (keys: Set<string>) => Promise<Map<string, CslItemData>>;

export interface InjectOptions {
  libraryType: string;
  userId: string;
  style: string;
}

const NO_ZCITE_WARNING =
  'No <zcite> placeholders found: the output is an unchanged copy. Write them in the document body as <zcite keys="ITEMKEY"/> ' +
  "(headers, footers, footnotes and comments are not scanned).";

function mixedWarning(count: number): string {
  return (
    `The document also has ${count} Pandoc citation marker(s) ([@key]): they were left as text, because a document with ` +
    "<zcite> placeholders is treated as a zcite document. To turn them into citations too, call inject_citations again " +
    "on the output file."
  );
}

const EXISTING_BIBLIOGRAPHY_WARNING =
  "The document already has a Zotero bibliography: the new citations were added but no second bibliography was written " +
  "(Zotero rebuilds the single bibliography on Refresh).";

function numberedWarning(style: string, withNum: number, total: number, app: string): string {
  return (
    `Style '${style}' requires 'num' attribute on <zcite> tags. Found ${withNum}/${total} tags with num. ` +
    `Citations without num show [?] until the user runs Zotero → Refresh in ${app}; to get the numbers now, add ` +
    'num="N" (order of first citation) to every <zcite> in the original file and run again.'
  );
}

/**
 * Risolve le richieste di citazione: valida le chiavi (solo chiavi Zotero ben formate raggiungono l'API),
 * recupera le voci dalla sorgente, verifica le chiavi mancanti e costruisce le citazioni con il testo
 * provvisorio. Lancia InjectionError senza scrivere nulla se una chiave è invalida o assente.
 */
export async function resolveCitations(
  requests: CitationRequest[],
  itemSource: ItemSource,
  opts: InjectOptions
): Promise<PreparedCitation[]> {
  const uniqueKeys = new Set(requests.flatMap((r) => r.keys));

  // Keys from the document go into API URL paths and Zotero URIs: only well-formed Zotero keys, so a
  // crafted <zcite> cannot point the request at another endpoint, and a key Zotero would reject never
  // reaches the document. The skill's inject.js applies the same check.
  const invalid = [...uniqueKeys].filter((k) => !ZOTERO_KEY.test(k));
  if (invalid.length > 0) {
    throw new InjectionError(
      "invalid_key",
      `Invalid Zotero item key(s) in <zcite>: ${invalid.join(", ")} (a key is 8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ). ` +
        "No file was written. Use the keys returned by search_library, add_items_by_doi or add_items."
    );
  }

  const cslData = await itemSource(uniqueKeys);
  // No placeholder citations: a citation of a nonexistent item fails the injection, like the skill's
  // inject.js with a key missing from metadata.json.
  const missingKeys = [...uniqueKeys].filter((k) => !cslData.has(k));
  if (missingKeys.length > 0) {
    throw new InjectionError(
      "missing_keys",
      `${missingKeys.length} cited key(s) not found in the library: ${missingKeys.join(", ")}. No file was written. ` +
        "Fix these keys in the document (find existing items with search_library, or add the missing ones with add_items_by_doi " +
        "or add_items) and call again; for a group library pass library_type and library_id."
    );
  }

  return requests.map((request) => {
    const items = buildCitationItems(request, cslData, opts.libraryType, opts.userId);
    const itemData = request.keys.map((k) => cslData.get(k) ?? { type: "article-journal" });
    const formattedText = formatCitationText(itemData, opts.style, request);
    return { request, items, itemData, formattedText };
  });
}

/**
 * Inietta le citazioni nel pacchetto `zip` già caricato, con lo scrittore dato: normalizza il corpo, trova
 * i segnaposto, li risolve e li sostituisce, aggiunge la bibliografia e scrive le preferenze del documento.
 * Non scrive su disco (lo fa injectFile). Restituisce il numero di segnaposto trovati/iniettati e gli avvisi.
 */
export async function injectPackage(
  zip: JSZip,
  writer: FormatWriter,
  itemSource: ItemSource,
  opts: InjectOptions,
  citekeyLookup?: CitekeyLookup
): Promise<{ found: number; injected: number; warnings: string[] }> {
  const rawBody = await zip.file(writer.bodyPart)!.async("string");

  // Internal recognition, no input flag. A document that contains <zcite> is a zcite document and takes
  // exactly the path it does today (same code, same byte output); Pandoc markers in it, if any, are only
  // reported. Otherwise, if it has Pandoc markers, the Pandoc branch runs. Neither: an unchanged copy.
  if (rawBody.includes("zcite")) {
    return injectZciteBranch(rawBody, zip, writer, itemSource, opts);
  }
  if (citekeyLookup) {
    // The Pandoc branch itself returns an unchanged copy (found 0) if it finds no markers.
    return injectPandocBranch(rawBody, zip, writer, itemSource, opts, citekeyLookup);
  }
  return { found: 0, injected: 0, warnings: [NO_ZCITE_WARNING] };
}

/** The zcite path, identical to before, plus a note when the document also carries Pandoc markers. */
async function injectZciteBranch(
  rawBody: string,
  zip: JSZip,
  writer: FormatWriter,
  itemSource: ItemSource,
  opts: InjectOptions
): Promise<{ found: number; injected: number; warnings: string[] }> {
  let body = writer.normalize(rawBody);

  const requests = parseZciteTags(body);
  if (requests.length === 0) {
    return { found: 0, injected: 0, warnings: [NO_ZCITE_WARNING] };
  }

  const warnings: string[] = [];
  if (opts.style === "ieee" || opts.style === "vancouver") {
    const withNum = requests.filter((r) => r.num !== undefined).length;
    if (withNum < requests.length) warnings.push(numberedWarning(opts.style, withNum, requests.length, writer.app));
  }

  const prepared = await resolveCitations(requests, itemSource, opts);

  let injected = 0;
  for (const p of prepared) {
    const citationXml = writer.citationXml(p);
    const newBody = writer.replaceTag(body, p.request.raw, citationXml);
    if (newBody !== body) {
      body = newBody;
      injected++;
    }
  }

  body = writer.appendBibliography(body);
  zip.file(writer.bodyPart, body);

  const prefs = await writer.writePrefs(zip, opts.style);
  warnings.push(...writer.prefsWarnings(prefs));

  // Mixed document: report the Pandoc markers left as text (counted on the unmodified body).
  const pandoc = countPandocMarkers(rawBody);
  if (pandoc > 0) warnings.push(mixedWarning(pandoc));

  return { found: requests.length, injected, warnings };
}

/**
 * The Pandoc path: merge split markers, parse `[@key]`/inline citations, resolve Better BibTeX citekeys to
 * Zotero keys, then reuse the same resolve + writer machinery as zcite. If the document already has a
 * Zotero bibliography (e.g. a second call on a once-injected file), no second one is written.
 */
async function injectPandocBranch(
  rawBody: string,
  zip: JSZip,
  writer: FormatWriter,
  itemSource: ItemSource,
  opts: InjectOptions,
  citekeyLookup: CitekeyLookup
): Promise<{ found: number; injected: number; warnings: string[] }> {
  let body = normalizePandocBody(writer, rawBody);

  const parsed = parsePandocCitesInBody(body);
  if (parsed.length === 0) {
    return { found: 0, injected: 0, warnings: [NO_ZCITE_WARNING] };
  }

  const requests = await resolveCitekeys(parsed, citekeyLookup);

  // Numbered styles: number by order of first citation (Pandoc markers carry no num attribute).
  if (opts.style === "ieee" || opts.style === "vancouver") {
    const nums = assignNumbers(requests);
    for (const r of requests) r.num = nums.get(r);
  }

  const prepared = await resolveCitations(requests, itemSource, opts);

  const warnings: string[] = [];
  let injected = 0;
  // Replace longer markers first: an inline `@KEY` is a substring of `-@KEY` (and of a longer citekey), so
  // replacing the shorter one first could match inside the longer. Length-descending removes that overlap;
  // numbering was already assigned in document order above.
  for (const p of [...prepared].sort((a, b) => b.request.raw.length - a.request.raw.length)) {
    const citationXml = writer.citationXml(p);
    const newBody = writer.replaceTag(body, p.request.raw, citationXml);
    if (newBody !== body) {
      body = newBody;
      injected++;
    }
  }

  // A once-injected document already has one bibliography; do not add a second (Zotero keeps one).
  if (body.includes("ZOTERO_BIBL")) {
    warnings.push(EXISTING_BIBLIOGRAPHY_WARNING);
  } else {
    body = writer.appendBibliography(body);
  }
  zip.file(writer.bodyPart, body);

  const prefs = await writer.writePrefs(zip, opts.style);
  warnings.push(...writer.prefsWarnings(prefs));

  return { found: parsed.length, injected, warnings };
}

/** Pandoc run/span merge for the writer's format; falls back to the body unchanged for an unknown format. */
function normalizePandocBody(writer: FormatWriter, body: string): string {
  return writer.normalizePandoc ? writer.normalizePandoc(body) : body;
}

/**
 * Iniezione completa su un file: deriva "<nome>_cited<ext>" dal solo basename (una cartella che contiene
 * ".docx" resta intatta), carica il pacchetto, inietta e salva l'output in modo atomico.
 */
export async function injectFile(
  filePath: string,
  writer: FormatWriter,
  itemSource: ItemSource,
  opts: InjectOptions,
  citekeyLookup?: CitekeyLookup
): Promise<InjectionResult> {
  const { dir, name, ext } = parse(filePath);
  const outputPath = format({ dir, name: `${name}_cited`, ext });

  const fileBuffer = await readFile(filePath);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch (err) {
    throw new InjectionError("invalid_package", writer.invalidPackageMessage(err instanceof Error ? err.message : String(err)));
  }

  writer.sniff?.(zip); // mismatch di formato (docx vs odt): messaggio chiaro prima del controllo del corpo
  if (!zip.file(writer.bodyPart)) {
    throw new InjectionError("no_document", writer.bodyMissingMessage);
  }

  const { found, injected, warnings } = await injectPackage(zip, writer, itemSource, opts, citekeyLookup);

  if (writer.finalize) await writer.finalize(zip);
  const buffer = await zip.generateAsync({ type: "nodebuffer", ...writer.generateOptions });
  await writeFileAtomic(outputPath, buffer);

  return { outputPath, found, injected, warnings };
}
