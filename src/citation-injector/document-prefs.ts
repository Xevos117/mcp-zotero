import JSZip from "jszip";
import { randomBytes } from "node:crypto";

/**
 * Zotero document preferences (style, field type) in docProps/custom.xml, as Zotero for Word writes them: the
 * serialized document data split into the custom properties ZOTERO_PREF_1…n, at most 255 characters each (Word's
 * limit for a property; the plugin concatenates _1, _2… until one is missing). Without them the first Refresh opens
 * Document Preferences and proposes Zotero's last used style instead of the injected one (H-W1, word-proxy job).
 * A document that already has ZOTERO_PREF_* properties is already managed by Zotero and is left as it is.
 * The skill's inject.js writes the same properties (keep both in sync).
 */

/** Tool style → id of the CSL style shipped with Zotero (class in-text). */
export const ZOTERO_STYLE_IDS: Record<string, string> = {
  apa: "http://www.zotero.org/styles/apa",
  ieee: "http://www.zotero.org/styles/ieee",
  vancouver: "http://www.zotero.org/styles/nlm-citation-sequence",
  harvard: "http://www.zotero.org/styles/harvard-cite-them-right",
  chicago: "http://www.zotero.org/styles/chicago-author-date",
};

const CUSTOM_PART = "docProps/custom.xml";
const CUSTOM_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const CUSTOM_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
/** fmtid of user-defined custom properties. */
const FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
export const PREF_CHUNK = 255;
const SESSION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sessionId(): string {
  return [...randomBytes(8)].map((b) => SESSION_ALPHABET[b % SESSION_ALPHABET.length]).join("");
}

/** Tipo di campo nelle preferenze: Field per Word, ReferenceMark per LibreOffice. */
export type ZoteroFieldType = "Field" | "ReferenceMark";

/**
 * The document data Zotero serializes (data-version 3), citations in the text (no noteType). `fieldType`
 * is Field for Word fields and ReferenceMark for LibreOffice reference marks.
 */
export function zoteroDocumentData(styleId: string, fieldType: ZoteroFieldType = "Field", session = sessionId()): string {
  return (
    `<data data-version="3"><session id="${session}"/>` +
    `<style id="${escapeXml(styleId)}" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/>` +
    `<prefs><pref name="fieldType" value="${fieldType}"/></prefs></data>`
  );
}

/** The value split into ZOTERO_PREF_1…n chunks. */
export function prefChunks(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length; i += PREF_CHUNK) out.push(value.slice(i, i + PREF_CHUNK));
  return out;
}

/** "written": preferences added; "kept": the document already had Zotero preferences; "skipped": nothing written. */
export type DocumentPrefsOutcome = "written" | "kept" | "skipped";

export const EXISTING_PREFS_WARNING =
  "The document already has Zotero document preferences (ZOTERO_PREF_* in docProps/custom.xml): kept as they are, so on the " +
  "first Refresh Zotero uses the style saved there, not the style of this injection.";

export const PREFS_NOT_WRITTEN_WARNING =
  "Zotero document preferences not written: the document's custom properties part could not be merged into, so Zotero may " +
  "ask for the document style (Document Preferences) on the first Refresh.";

/** Part name of the custom properties: the target of the package relationship if there is one, else docProps/custom.xml. */
function customPartName(rels: string | undefined): string {
  for (const m of (rels ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    if (!m[0].includes(CUSTOM_REL_TYPE)) continue;
    const target = /\bTarget=["']([^"']+)["']/.exec(m[0])?.[1];
    if (target) return target.replace(/^\/+/, "");
  }
  return CUSTOM_PART;
}

/**
 * Writes the Zotero document preferences for `style` into the docx: the custom properties part (merged into an
 * existing one, with its root's namespace prefix), its content type and its package relationship, each only when
 * missing. Never rewrites an existing part it cannot merge into: then nothing changes ("skipped"). A document that
 * already has ZOTERO_PREF_* properties is left as it is ("kept").
 */
export async function writeZoteroDocumentPrefs(zip: JSZip, style: string): Promise<DocumentPrefsOutcome> {
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
  const properties = prefChunks(zoteroDocumentData(styleId))
    .map((chunk, i) => `<${prefix}property fmtid="${FMTID}" pid="${++pid}" name="ZOTERO_PREF_${i + 1}"><vt:lpwstr>${escapeXml(chunk)}</vt:lpwstr></${prefix}property>`)
    .join("");
  if (existing) {
    if (!root) return "skipped";
    let merged: string;
    if (root[3]) {
      // empty root <Properties …/>
      merged = existing.replace(root[0], `<${prefix}Properties${root[2]}>${properties}</${prefix}Properties>`);
    } else {
      const close = `</${prefix}Properties>`;
      const at = existing.lastIndexOf(close);
      if (at < 0) return "skipped";
      merged = existing.slice(0, at) + properties + existing.slice(at);
    }
    // the vt prefix of the new properties must be declared on the root
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
