import { readFileSync } from "node:fs";
import { posix } from "node:path";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import AjvModule from "ajv";
import CSL from "citeproc";

/**
 * Validatore dei .docx prodotti da inject_citations e da inject.js (skill).
 *
 * Controlla ciò che si può verificare senza Word: parti dello zip e content types, XML ben formato,
 * bilanciamento dei campi (fldChar begin/separate/end), JSON dei campi ZOTERO_ITEM/ZOTERO_BIBL contro
 * gli schemi CSL ufficiali (con le deroghe documentate in RELAXATIONS), forma degli URI, e un rendering
 * reale con citeproc-js: ogni citazione e la bibliografia devono essere processabili, e il testo visibile
 * scritto dal prodotto deve contenere le stesse parti chiave (cognome e anno, oppure i numeri) che
 * produrrebbe lo stile CSL vero. Il confronto è volutamente solo sulle parti chiave: il testo
 * provvisorio non pretende di essere identico a quello che Zotero scrive al primo Refresh.
 *
 * Il file usa solo sintassi TypeScript cancellabile e solo import di pacchetti, così può essere
 * caricato anche con `node --experimental-strip-types` fuori da vitest.
 */

export type CitationStyle = "apa" | "ieee" | "vancouver" | "harvard" | "chicago";

const CSL_DIR = new URL("../fixtures/csl/", import.meta.url);

/** Stile del tool → file CSL vendorizzato (vedi test/fixtures/csl/README.md). */
export const STYLE_FILES: Record<CitationStyle, string> = {
  apa: "apa.csl",
  ieee: "ieee.csl",
  vancouver: "nlm-citation-sequence.csl", // "vancouver" in Zotero = NLM citation-sequence
  harvard: "harvard-cite-them-right.csl",
  chicago: "chicago-author-date.csl", // il testo provvisorio del prodotto è autore-anno
};
const NUMERIC_STYLES = new Set<CitationStyle>(["ieee", "vancouver"]);

/** URI di una voce Zotero come la scrive il prodotto (e Zotero stesso). */
export const ZOTERO_URI = /^http:\/\/zotero\.org\/(users|groups)\/\d+\/items\/[A-Z0-9]{8}$/;

/** URL dello schema che Zotero scrive in ogni campo (diverso dall'enum dello schema ufficiale). */
export const ZOTERO_SCHEMA_URL = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";

/**
 * Deroghe allo schema CSL ufficiale. Le prime tre riproducono ciò che scrive Zotero for Word;
 * l'ultima è una differenza del prodotto rispetto a Zotero, tracciata come ipotesi H-W3 in
 * test/WORD_CHECKLIST.md e come it.fails nei test.
 */
export const RELAXATIONS = [
  "schema: accettato anche l'URL github/raw/master che Zotero scrive al posto dell'enum resource.citationstyles.org",
  "citationItems[].uri: campo legacy che Zotero scrive accanto a uris",
  "properties: ammessi formattedCitation, plainCitation e dontUpdate (scritti da Zotero), non solo noteIndex",
  "itemData.id non obbligatorio (il prodotto non lo scrive; Zotero sì) — ipotesi H-W3",
] as const;

export interface FieldInfo {
  instr: string;
  result: string;
}

export interface CitationField {
  json: Record<string, any>;
  /** Testo visibile del campo (risultato tra separate ed end), già decodificato. */
  visible: string;
}

export interface ZoteroParity {
  /** docProps/custom.xml contiene preferenze ZOTERO_PREF_* (ipotesi H-W1). */
  hasDocumentPrefs: boolean;
  /** Ogni citazione ha properties.plainCitation (ipotesi H-W2). */
  allHavePlainCitation: boolean;
  /** Ogni citazione ha properties.noteIndex, che Zotero scrive (0 nei documenti senza note) (ipotesi H-W2). */
  allHaveNoteIndex: boolean;
  /** Ogni itemData ha un id e lo stesso URI ha sempre lo stesso id, URI diversi id diversi (ipotesi H-W3). */
  consistentItemIds: boolean;
  /** Ogni citationItem con locator ha anche label (ipotesi H-W4). */
  locatorsHaveLabel: boolean;
}

export interface DocxReport {
  documentXml: string;
  fields: FieldInfo[];
  citations: CitationField[];
  bibliography: Record<string, unknown> | null;
  /** Testo di ogni citazione e voci di bibliografia secondo citeproc con lo stile CSL vero. */
  rendered: { citations: string[]; bibliography: string[] } | null;
  /** Problemi strutturali: un docx con errori non è utilizzabile da Word/Zotero. */
  errors: string[];
  /** Testo visibile che non corrisponde allo stile CSL nelle parti chiave. */
  mismatches: string[];
  parity: ZoteroParity;
}

export interface ValidateOptions {
  /** Stile usato all'iniezione (default apa). */
  style?: CitationStyle;
  /** Ammette segnaposto <zcite> rimasti nel documento (default: errore). */
  allowLeftoverZcite?: boolean;
  /** Richiede il campo ZOTERO_BIBL quando ci sono citazioni (default true). */
  requireBibliography?: boolean;
  /** Prefisso libreria atteso negli URI, es. "users/123" o "groups/777". */
  libraryPath?: string;
}

const Ajv = ((AjvModule as any).default ?? AjvModule) as new (opts: Record<string, unknown>) => any;
let citationValidator: ((data: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string }> | null };
let localeXml: string | undefined;

function readFixture(name: string): string {
  return readFileSync(new URL(name, CSL_DIR), "utf8");
}

function getCitationValidator() {
  if (citationValidator) return citationValidator;
  const data = JSON.parse(readFixture("csl-data.json"));
  const citation = JSON.parse(readFixture("csl-citation.json"));
  data.items.required = data.items.required.filter((r: string) => r !== "id");
  citation.properties.schema.enum.push(ZOTERO_SCHEMA_URL);
  const itemProps = citation.properties.citationItems.items.properties;
  itemProps.uri = { type: "array", items: { type: "string" } };
  const props = citation.properties.properties.properties;
  props.formattedCitation = { type: "string" };
  props.plainCitation = { type: "string" };
  props.dontUpdate = { type: "boolean" };
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addSchema(data);
  citationValidator = ajv.compile(citation);
  return citationValidator;
}

export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** JSON CSL_CITATION di ogni campo ZOTERO_ITEM, nell'ordine del documento (helper per le asserzioni). */
export function citations(xml: string): Array<Record<string, any>> {
  return parseFields(xml, []).fields
    .filter((f) => f.instr.trimStart().startsWith("ADDIN ZOTERO_ITEM CSL_CITATION"))
    .map((f) => JSON.parse(f.instr.trim().slice("ADDIN ZOTERO_ITEM CSL_CITATION".length)));
}

/** Scansione in ordine dei campi: gestisce instrText su più run e campi annidati. */
function parseFields(xml: string, errors: string[]): { fields: FieldInfo[] } {
  const token =
    /<w:fldChar\b[^>]*?w:fldCharType="(begin|separate|end)"[^>]*>|<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>|<w:t\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  const stack: Array<{ instr: string; result: string; separated: boolean }> = [];
  const fields: FieldInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = token.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1] === "begin") stack.push({ instr: "", result: "", separated: false });
    else if (m[1] === "separate") {
      if (!top) errors.push(`fldChar separate senza begin (offset ${m.index})`);
      else if (top.separated) errors.push(`fldChar separate ripetuto nello stesso campo (offset ${m.index})`);
      else top.separated = true;
    } else if (m[1] === "end") {
      const done = stack.pop();
      if (!done) errors.push(`fldChar end senza begin (offset ${m.index})`);
      else {
        if (!done.separated) errors.push(`campo senza separate: ${done.instr.slice(0, 60)}`);
        fields.push({ instr: decodeXml(done.instr), result: decodeXml(done.result) });
        // il risultato di un campo annidato fa parte del risultato del campo esterno
        if (stack.length) stack[stack.length - 1].result += done.result;
      }
    } else if (m[2] !== undefined) {
      if (!top) errors.push("instrText fuori da un campo");
      else if (top.separated) errors.push("instrText dopo separate");
      else top.instr += m[2];
    } else if (m[3] !== undefined && top?.separated) top.result += m[3];
  }
  if (stack.length) errors.push(`${stack.length} campo/i senza fldChar end`);
  return { fields };
}

async function checkPackage(zip: JSZip, errors: string[]): Promise<void> {
  for (const required of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
    if (!zip.file(required)) errors.push(`parte mancante: ${required}`);
  }
  const parts = Object.values(zip.files).filter((f) => !f.dir);
  for (const part of parts) {
    if (!/\.(xml|rels)$/.test(part.name)) continue;
    const res = XMLValidator.validate(await part.async("string"));
    if (res !== true) errors.push(`XML non valido in ${part.name}: ${res.err.msg} (riga ${res.err.line})`);
  }
  const ctEntry = zip.file("[Content_Types].xml");
  if (ctEntry) {
    const ct = await ctEntry.async("string");
    const defaults = new Set([...ct.matchAll(/<Default\b[^>]*Extension="([^"]+)"/g)].map((x) => x[1].toLowerCase()));
    const overrides = new Map([...ct.matchAll(/<Override\b[^>]*PartName="([^"]+)"[^>]*ContentType="([^"]+)"/g)].map((x) => [x[1], x[2]]));
    for (const part of parts) {
      if (part.name === "[Content_Types].xml") continue;
      const ext = part.name.split(".").pop()!.toLowerCase();
      if (!overrides.has(`/${part.name}`) && !defaults.has(ext)) errors.push(`nessun content type per ${part.name}`);
    }
    const main = overrides.get("/word/document.xml");
    if (main !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") {
      errors.push(`content type di /word/document.xml non è quello di WordprocessingML: ${main ?? "assente"}`);
    }
  }
  // ogni Override deve puntare a una parte esistente
  if (ctEntry) {
    const ct = await ctEntry.async("string");
    for (const [, partName] of ct.matchAll(/<Override\b[^>]*PartName="([^"]+)"/g)) {
      if (!zip.file(partName.replace(/^\//, ""))) errors.push(`content type per una parte inesistente: ${partName}`);
    }
  }
  // ogni relazione interna (anche word/_rels/*.rels) deve risolvere a una parte del pacchetto
  for (const part of parts.filter((p) => /(^|\/)_rels\/[^/]*\.rels$/.test(p.name))) {
    const sourceDir = part.name.replace(/_rels\/[^/]*\.rels$/, ""); // "word/_rels/document.xml.rels" → "word/"
    const xml = await part.async("string");
    for (const [rel] of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      if (/TargetMode="External"/.test(rel)) continue;
      const target = /Target="([^"]+)"/.exec(rel)?.[1];
      if (!target) continue;
      const resolved = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(sourceDir, target));
      if (!zip.file(resolved)) errors.push(`${part.name}: relazione verso una parte inesistente ${target}`);
    }
  }
  const relsEntry = zip.file("_rels/.rels");
  if (relsEntry) {
    const rels = await relsEntry.async("string");
    if (!/Type="[^"]*\/officeDocument"[^>]*Target="\/?word\/document\.xml"|Target="\/?word\/document\.xml"[^>]*Type="[^"]*\/officeDocument"/.test(rels)) {
      errors.push("_rels/.rels non punta a word/document.xml come officeDocument");
    }
  }
}

function firstFamily(item: Record<string, any>): string | undefined {
  const a = item.author?.[0];
  return (a?.family || a?.literal || undefined) as string | undefined;
}

function year(item: Record<string, any>): string | undefined {
  const y = item.issued?.["date-parts"]?.[0]?.[0];
  return y === undefined || y === "" ? undefined : String(y);
}

/** Numeri di citazione in un testo come "[2,3]", "[1]–[3]", "(1-3)": i range vengono espansi. */
export function citationNumbers(text: string): number[] {
  const out = new Set<number>();
  const tokens = text.match(/\d+|[–-]/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const n = Number(tokens[i]);
    if (Number.isNaN(n)) continue;
    if (tokens[i + 1] && /[–-]/.test(tokens[i + 1]) && tokens[i + 2] && !Number.isNaN(Number(tokens[i + 2]))) {
      for (let k = n; k <= Number(tokens[i + 2]); k++) out.add(k);
      i += 2;
    } else out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

interface CachedEngine {
  engine: any;
  sys: { items: Map<string, Record<string, any>>; retrieveLocale(): string | undefined; retrieveItem(id: string): Record<string, any> | undefined };
}
const engineCache = new Map<CitationStyle, CachedEngine>();
let validationSeq = 0;

/**
 * One citeproc engine per style, built once (building it costs ~1-2 s for apa/chicago) and reset for
 * each use: processor state cleared, item set replaced. Item ids are unique per validation, so data
 * cached by the engine for a previous document can never leak into this one.
 */
function engineFor(style: CitationStyle, items: Map<string, Record<string, any>>) {
  let cached = engineCache.get(style);
  if (!cached) {
    localeXml ??= readFixture("locales-en-US.xml");
    const sys: CachedEngine["sys"] = { items: new Map(), retrieveLocale: () => localeXml, retrieveItem: (id) => sys.items.get(id) };
    const engine = new (CSL as any).Engine(sys, readFixture(STYLE_FILES[style]), "en-US");
    engine.setOutputFormat("text");
    cached = { engine, sys };
    engineCache.set(style, cached);
  }
  cached.sys.items = items;
  cached.engine.restoreProcessorState([]);
  cached.engine.updateItems([...items.keys()]);
  return cached.engine;
}

/** Processa i cluster in ordine (noteIndex 0, come in un documento senza note) e restituisce il testo di ciascuno. */
function renderClusters(engine: any, clusters: Array<Array<Record<string, unknown>>>): string[] {
  const pre: Array<[string, number]> = [];
  const texts = new Map<string, string>();
  clusters.forEach((citationItems, i) => {
    const citationID = `mzt-c${i}`;
    const [, updates] = engine.processCitationCluster({ citationID, citationItems, properties: { noteIndex: 0 } }, pre, []);
    for (const [, text, id] of updates as Array<[number, string, string]>) texts.set(id, text);
    pre.push([citationID, 0]);
  });
  return clusters.map((_, i) => texts.get(`mzt-c${i}`) ?? "");
}

function renderWithCiteproc(report: DocxReport, style: CitationStyle): void {
  // id sintetici = URI della voce (+ numero di validazione): stabili tra citazioni, indipendenti da citationItems[].id
  const run = ++validationSeq;
  const idOf = (uri: string) => `${uri}#v${run}`;
  const items = new Map<string, Record<string, any>>();
  const seen = new Set<string>();
  const clusters: Array<Array<Record<string, unknown>>> = [];
  const keyClusters: Array<Array<Record<string, unknown>>> = [];
  for (const c of report.citations) {
    const full: Array<Record<string, unknown>> = [];
    for (const ci of c.json.citationItems ?? []) {
      const uri = ci.uris?.[0];
      if (!uri || !ci.itemData) continue;
      if (!seen.has(uri)) {
        seen.add(uri);
        items.set(idOf(uri), { ...ci.itemData, id: idOf(uri) });
      }
      const entry: Record<string, unknown> = { id: idOf(uri) };
      for (const k of ["locator", "label", "prefix", "suffix"]) if (ci[k] !== undefined) entry[k] = ci[k];
      full.push(entry);
    }
    clusters.push(full);
    keyClusters.push(full.map((e) => ({ id: e.id })));
  }
  if (items.size === 0) return;
  try {
    // stesso motore per i due passaggi: testo completo, poi solo le voci (confronto delle parti chiave)
    const engine = engineFor(style, items);
    const rendered = renderClusters(engine, clusters);
    engine.restoreProcessorState([]);
    engine.updateItems([...items.keys()]);
    const keyTexts = renderClusters(engine, keyClusters);
    const bib = engine.makeBibliography();
    const entries: string[] = bib ? (bib[1] as string[]).map((e) => e.trim()) : [];
    report.rendered = { citations: rendered, bibliography: entries };
    rendered.forEach((t, i) => {
      if (!t.trim()) report.errors.push(`citeproc: citazione ${i + 1} vuota con lo stile ${style}`);
    });
    if (entries.length !== items.size) {
      report.errors.push(`citeproc: bibliografia con ${entries.length} voci, attese ${items.size} (voci distinte citate)`);
    }
    report.citations.forEach((c, i) => compareKeyParts(report, style, c, keyTexts[i], i));
  } catch (e) {
    report.errors.push(`citeproc: rendering fallito con lo stile ${style}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function compareKeyParts(report: DocxReport, style: CitationStyle, c: CitationField, rendered: string, i: number): void {
  const where = `citazione ${i + 1} ("${c.visible}" vs citeproc "${rendered}")`;
  if (NUMERIC_STYLES.has(style)) {
    const visible = citationNumbers(c.visible);
    const expected = citationNumbers(rendered);
    if (visible.join(",") !== expected.join(",")) report.mismatches.push(`${where}: numeri ${visible} ≠ ${expected}`);
    return;
  }
  for (const ci of c.json.citationItems ?? []) {
    const family = firstFamily(ci.itemData ?? {});
    const y = year(ci.itemData ?? {});
    if (family && !c.visible.includes(family)) report.mismatches.push(`${where}: cognome "${family}" assente dal testo visibile`);
    if (family && !rendered.includes(family)) report.mismatches.push(`${where}: cognome "${family}" assente dal rendering CSL`);
    if (y && !c.visible.includes(y)) report.mismatches.push(`${where}: anno ${y} assente dal testo visibile`);
    if (y && !rendered.includes(y)) report.mismatches.push(`${where}: anno ${y} assente dal rendering CSL`);
    if (!y && !c.visible.includes("n.d.")) report.mismatches.push(`${where}: voce senza anno ma "n.d." assente`);
  }
}

function checkCitation(json: Record<string, any>, visible: string, idx: number, opts: ValidateOptions, errors: string[]): void {
  const where = `citazione ${idx + 1}`;
  const validate = getCitationValidator();
  if (!validate(json)) {
    for (const e of validate.errors ?? []) errors.push(`${where}: schema csl-citation ${e.instancePath || "/"} ${e.message}`);
  }
  if (!Array.isArray(json.citationItems) || json.citationItems.length === 0) errors.push(`${where}: citationItems vuoto`);
  if (json.properties?.formattedCitation !== visible) {
    errors.push(`${where}: formattedCitation "${json.properties?.formattedCitation}" ≠ testo visibile "${visible}"`);
  }
  for (const ci of json.citationItems ?? []) {
    const uris: unknown[] = ci.uris ?? [];
    if (uris.length === 0) errors.push(`${where}: citationItem senza uris`);
    for (const u of uris) {
      if (typeof u !== "string" || !ZOTERO_URI.test(u)) errors.push(`${where}: URI non valido ${JSON.stringify(u)}`);
      else if (opts.libraryPath && !u.startsWith(`http://zotero.org/${opts.libraryPath}/items/`)) {
        errors.push(`${where}: URI ${u} fuori dalla libreria attesa ${opts.libraryPath}`);
      }
    }
    if (ci.uri !== undefined && JSON.stringify(ci.uri) !== JSON.stringify(ci.uris)) errors.push(`${where}: uri ≠ uris`);
    if (!ci.itemData || typeof ci.itemData !== "object") errors.push(`${where}: itemData mancante`);
  }
}

function computeParity(zipHasPrefs: boolean, cites: CitationField[]): ZoteroParity {
  const all = cites.flatMap((c) => (c.json.citationItems ?? []) as Array<Record<string, any>>);
  const idByUri = new Map<string, unknown>();
  const uriById = new Map<string, string>();
  let consistent = all.every((ci) => ci.itemData?.id !== undefined);
  for (const ci of all) {
    const uri = ci.uris?.[0];
    const id = ci.itemData?.id ?? ci.id;
    if (idByUri.has(uri) && idByUri.get(uri) !== id) consistent = false;
    if (uriById.has(String(id)) && uriById.get(String(id)) !== uri) consistent = false;
    idByUri.set(uri, id);
    uriById.set(String(id), uri);
  }
  return {
    hasDocumentPrefs: zipHasPrefs,
    allHavePlainCitation: cites.every((c) => typeof c.json.properties?.plainCitation === "string"),
    allHaveNoteIndex: cites.every((c) => typeof c.json.properties?.noteIndex === "number"),
    consistentItemIds: consistent,
    locatorsHaveLabel: all.every((ci) => ci.locator === undefined || typeof ci.label === "string"),
  };
}

/** Valida un .docx iniettato; non lancia: errori e differenze sono nel report. */
export async function validateDocx(docx: Buffer | Uint8Array, opts: ValidateOptions = {}): Promise<DocxReport> {
  const style = opts.style ?? "apa";
  const errors: string[] = [];
  const report: DocxReport = {
    documentXml: "",
    fields: [],
    citations: [],
    bibliography: null,
    rendered: null,
    errors,
    mismatches: [],
    parity: { hasDocumentPrefs: false, allHavePlainCitation: true, allHaveNoteIndex: true, consistentItemIds: true, locatorsHaveLabel: true },
  };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(docx);
  } catch (e) {
    errors.push(`non è uno zip valido: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }
  await checkPackage(zip, errors);
  const doc = zip.file("word/document.xml");
  if (!doc) return report;
  report.documentXml = await doc.async("string");
  if (!opts.allowLeftoverZcite && /&lt;zcite\b/.test(report.documentXml)) errors.push("segnaposto <zcite> rimasti nel documento");

  report.fields = parseFields(report.documentXml, errors).fields;
  for (const f of report.fields) {
    const instr = f.instr.trim();
    if (instr.startsWith("ADDIN ZOTERO_ITEM")) {
      if (!instr.startsWith("ADDIN ZOTERO_ITEM CSL_CITATION ")) {
        errors.push(`campo ZOTERO_ITEM senza CSL_CITATION: ${instr.slice(0, 60)}`);
        continue;
      }
      try {
        const json = JSON.parse(instr.slice("ADDIN ZOTERO_ITEM CSL_CITATION ".length));
        checkCitation(json, f.result, report.citations.length, opts, errors);
        report.citations.push({ json, visible: f.result });
      } catch (e) {
        errors.push(`JSON CSL_CITATION non valido: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (instr.startsWith("ADDIN ZOTERO_BIBL")) {
      if (report.bibliography) errors.push("più di un campo ZOTERO_BIBL");
      const m = /^ADDIN ZOTERO_BIBL (\{.*\}) CSL_BIBLIOGRAPHY$/.exec(instr);
      try {
        const bib = JSON.parse(m?.[1] ?? "") as Record<string, unknown>;
        for (const k of ["uncited", "omitted", "custom"]) if (!Array.isArray(bib[k])) errors.push(`ZOTERO_BIBL: ${k} non è un array`);
        report.bibliography = bib;
      } catch {
        errors.push(`campo ZOTERO_BIBL non valido: ${instr.slice(0, 80)}`);
      }
    }
  }
  if ((opts.requireBibliography ?? true) && report.citations.length > 0 && !report.bibliography) {
    errors.push("citazioni presenti ma nessun campo ZOTERO_BIBL");
  }
  const custom = zip.file("docProps/custom.xml");
  const prefs = custom ? /ZOTERO_PREF/.test(await custom.async("string")) : false;
  report.parity = computeParity(prefs, report.citations);
  if (errors.length === 0) renderWithCiteproc(report, style);
  return report;
}

/** Come validateDocx, ma lancia un errore con l'elenco completo se ci sono errori o differenze. */
export async function expectValidDocx(
  docx: Buffer | Uint8Array,
  opts: ValidateOptions & { allowMismatches?: boolean } = {}
): Promise<DocxReport> {
  const report = await validateDocx(docx, opts);
  const problems = [...report.errors, ...(opts.allowMismatches ? [] : report.mismatches)];
  if (problems.length) throw new Error(`docx non valido (${opts.style ?? "apa"}):\n- ${problems.join("\n- ")}`);
  return report;
}
