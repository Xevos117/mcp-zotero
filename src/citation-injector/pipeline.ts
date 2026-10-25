import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import { format, parse } from "node:path";
import { CslItemData } from "../types/csl-types.js";
import { ZOTERO_KEY } from "../utils/zotero-keys.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { CitationRequest, InjectionError, PreparedCitation } from "./model.js";
import { parseZciteTags } from "./zcite.js";
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
  opts: InjectOptions
): Promise<{ found: number; injected: number; warnings: string[] }> {
  let body = await zip.file(writer.bodyPart)!.async("string");
  body = writer.normalize(body);

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

  return { found: requests.length, injected, warnings };
}

/**
 * Iniezione completa su un file: deriva "<nome>_cited<ext>" dal solo basename (una cartella che contiene
 * ".docx" resta intatta), carica il pacchetto, inietta e salva l'output in modo atomico.
 */
export async function injectFile(
  filePath: string,
  writer: FormatWriter,
  itemSource: ItemSource,
  opts: InjectOptions
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

  const { found, injected, warnings } = await injectPackage(zip, writer, itemSource, opts);

  if (writer.finalize) await writer.finalize(zip);
  const buffer = await zip.generateAsync({ type: "nodebuffer", ...writer.generateOptions });
  await writeFileAtomic(outputPath, buffer);

  return { outputPath, found, injected, warnings };
}
