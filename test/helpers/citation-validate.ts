import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import {
  type CitationStyle,
  type CitationField,
  type DocxReport,
  type ValidateOptions,
  checkCitation,
  renderWithCiteproc,
  decodeXml,
  styleId,
  expectValidDocx,
} from "./docx-validate.ts";

/**
 * Validazione comune a Word e LibreOffice. Per docx si usa docx-validate (expectValidDocx); qui vive il
 * validatore ODT, che condivide con quello docx tutto ciò che è neutro: schema CSL della citazione, forma
 * degli URI e rendering con citeproc (la stessa macchina di docx-validate). `expectValidDocument` sceglie
 * il validatore in base al formato.
 */

const ODT_MIME = "application/vnd.oasis.opendocument.text";

/** Verifica che mimetype sia la prima voce dello zip, STORED e con il contenuto giusto (requisito ODF). */
function checkMimetype(bytes: Buffer | Uint8Array, errors: string[]): void {
  const b = Buffer.from(bytes);
  if (b.length < 30 || b.readUInt32LE(0) !== 0x04034b50) {
    errors.push("non inizia con l'header local di uno zip");
    return;
  }
  const method = b.readUInt16LE(8);
  const nameLen = b.readUInt16LE(26);
  const extraLen = b.readUInt16LE(28);
  const name = b.toString("latin1", 30, 30 + nameLen);
  if (name !== "mimetype") errors.push(`la prima voce dello zip è "${name}", non "mimetype"`);
  if (method !== 0) errors.push(`mimetype non è STORED (metodo di compressione ${method})`);
  const content = b.toString("latin1", 30 + nameLen + extraLen, 30 + nameLen + extraLen + ODT_MIME.length);
  if (content !== ODT_MIME) errors.push(`contenuto di mimetype inatteso: "${content}"`);
}

function decodeName(escaped: string): string {
  return decodeXml(escaped);
}

export interface OdtReport {
  /** content.xml (per l'impronta: testo dei paragrafi e nome della sezione ZOTERO_BIBL). */
  contentXml: string;
  /** Sempre vuoto: l'odt non ha i w:fldChar del docx; presente per compatibilità con chi legge report.fields. */
  fields: never[];
  citations: CitationField[];
  bibliography: Record<string, unknown> | null;
  rendered: { citations: string[]; bibliography: string[] } | null;
  errors: string[];
  mismatches: string[];
  documentPrefs: { styleId: string | null; fieldType: string | null; chunks: number } | null;
}

/** Valida un .odt iniettato; non lancia: errori e differenze sono nel report. */
export async function validateOdt(odt: Buffer | Uint8Array, opts: ValidateOptions = {}): Promise<OdtReport> {
  const style = (opts.style ?? "apa") as CitationStyle;
  const errors: string[] = [];
  const report: OdtReport = { contentXml: "", fields: [], citations: [], bibliography: null, rendered: null, errors, mismatches: [], documentPrefs: null };

  checkMimetype(odt, errors);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(odt);
  } catch (e) {
    errors.push(`non è uno zip valido: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }

  for (const required of ["mimetype", "content.xml", "META-INF/manifest.xml"]) {
    if (!zip.file(required)) errors.push(`parte mancante: ${required}`);
  }
  const content = zip.file("content.xml");
  if (!content) return report;
  const xml = await content.async("string");
  report.contentXml = xml;
  if (XMLValidator.validate(xml) !== true) errors.push("content.xml non è XML ben formato");
  if (/&lt;zcite\b/.test(xml)) errors.push("segnaposto <zcite> rimasti nel documento");

  // reference mark delle citazioni
  const markRe = /<text:reference-mark-start text:name="([^"]*)"\/>([\s\S]*?)<text:reference-mark-end text:name="([^"]*)"\/>/g;
  let m: RegExpExecArray | null;
  while ((m = markRe.exec(xml)) !== null) {
    const where = `citazione ${report.citations.length + 1}`;
    const startName = decodeName(m[1]);
    const endName = decodeName(m[3]);
    if (m[1] !== m[3]) errors.push(`${where}: nomi di start/end diversi`);
    const nameMatch = /^ZOTERO_ITEM CSL_CITATION ([\s\S]*) RND[0-9A-Za-z]{10}$/.exec(startName);
    if (!nameMatch) {
      errors.push(`${where}: nome del reference mark non nella forma "ZOTERO_ITEM CSL_CITATION {json} RND<10>"`);
      continue;
    }
    let json: Record<string, any>;
    try {
      json = JSON.parse(nameMatch[1]);
    } catch (e) {
      errors.push(`${where}: JSON CSL_CITATION non valido: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (/plainCitation/.test(nameMatch[1])) errors.push(`${where}: il reference mark non deve contenere plainCitation`);
    const visible = decodeXml(m[2]);
    checkCitation(json, visible, report.citations.length, opts, errors);
    report.citations.push({ json, visible });
  }

  // bibliografia: una sola sezione ZOTERO_BIBL con nome valido; stile Bibliography_20_1 definito
  const sections = [...xml.matchAll(/<text:section text:name="([^"]*)"/g)].map((s) => decodeName(s[1])).filter((n) => n.startsWith("ZOTERO_BIBL"));
  if (report.citations.length > 0 && sections.length === 0) errors.push("citazioni presenti ma nessuna sezione ZOTERO_BIBL");
  if (sections.length > 1) errors.push("più di una sezione ZOTERO_BIBL");
  for (const name of sections) {
    const bm = /^ZOTERO_BIBL (\{[\s\S]*\}) CSL_BIBLIOGRAPHY RND[0-9A-Za-z]{10}$/.exec(name);
    if (!bm) {
      errors.push("sezione ZOTERO_BIBL con nome non valido");
      continue;
    }
    try {
      const bib = JSON.parse(bm[1]) as Record<string, unknown>;
      for (const k of ["uncited", "omitted", "custom"]) if (!Array.isArray(bib[k])) errors.push(`ZOTERO_BIBL: ${k} non è un array`);
      report.bibliography = bib;
    } catch {
      errors.push("ZOTERO_BIBL: JSON non valido");
    }
    const styles = (await zip.file("styles.xml")?.async("string")) ?? "";
    if (!/style:name="Bibliography_20_1"/.test(styles)) errors.push('styles.xml senza lo stile Bibliography_20_1');
  }

  report.documentPrefs = await checkOdtPrefs(zip, (opts.documentPrefsStyle ?? style) as CitationStyle, errors, opts.requireDocumentPrefs);

  if (errors.length === 0) {
    // renderWithCiteproc lavora su un DocxReport: gli basta citations/errors/mismatches/rendered
    const asDocx = report as unknown as DocxReport;
    renderWithCiteproc(asDocx, style);
  }
  return report;
}

/** Preferenze in meta.xml: ZOTERO_PREF_1…n ricomposte danno <data data-version="3"> con lo stile e fieldType ReferenceMark. */
async function checkOdtPrefs(zip: JSZip, style: CitationStyle, errors: string[], required = false): Promise<OdtReport["documentPrefs"]> {
  const meta = (await zip.file("meta.xml")?.async("string")) ?? "";
  if (!/ZOTERO_PREF/.test(meta)) {
    if (required) errors.push("preferenze del documento assenti (nessun ZOTERO_PREF_* in meta.xml)");
    return null;
  }
  const chunks = new Map<number, string>();
  for (const pm of meta.matchAll(/<meta:user-defined\b[^>]*\bmeta:name="ZOTERO_PREF_(\d+)"[^>]*>([\s\S]*?)<\/meta:user-defined>/g)) {
    chunks.set(Number(pm[1]), decodeXml(pm[2]));
  }
  const n = chunks.size;
  for (let i = 1; i <= n; i++) {
    if (!chunks.has(i)) errors.push(`ZOTERO_PREF_${i} mancante (da _1 a _${n} senza buchi)`);
    else if (chunks.get(i)!.length > 255) errors.push(`ZOTERO_PREF_${i} oltre 255 caratteri`);
  }
  const value = [...chunks.keys()].sort((a, b) => a - b).map((k) => chunks.get(k)).join("");
  const prefs = {
    styleId: /<style\b[^>]*\bid="([^"]+)"/.exec(value)?.[1] ?? null,
    fieldType: /<pref name="fieldType" value="([^"]+)"/.exec(value)?.[1] ?? null,
    chunks: n,
  };
  if (n > 0) {
    if (!/^<data data-version="3"[ >][\s\S]*<\/data>$/.test(value)) errors.push('ZOTERO_PREF: il valore non è un <data data-version="3"> completo');
    if (prefs.styleId !== styleId(style)) errors.push(`ZOTERO_PREF: stile ${prefs.styleId} invece di ${styleId(style)} (${style})`);
    if (prefs.fieldType !== "ReferenceMark") errors.push(`ZOTERO_PREF: fieldType ${prefs.fieldType} invece di ReferenceMark`);
  }
  return prefs;
}

/** Come validateOdt, ma lancia con l'elenco completo in caso di errori o differenze. */
export async function expectValidOdt(
  odt: Buffer | Uint8Array,
  opts: ValidateOptions & { allowMismatches?: boolean } = {}
): Promise<OdtReport> {
  const report = await validateOdt(odt, opts);
  const problems = [...report.errors, ...(opts.allowMismatches ? [] : report.mismatches)];
  if (problems.length) throw new Error(`odt non valido (${opts.style ?? "apa"}):\n- ${problems.join("\n- ")}`);
  return report;
}

export type DocumentFormat = "docx" | "odt";

/** Valida un documento iniettato scegliendo il validatore in base al formato. */
export async function expectValidDocument(
  bytes: Buffer | Uint8Array,
  opts: ValidateOptions & { format: DocumentFormat; allowMismatches?: boolean }
): Promise<void> {
  if (opts.format === "odt") await expectValidOdt(bytes, opts);
  else await expectValidDocx(bytes, opts);
}
