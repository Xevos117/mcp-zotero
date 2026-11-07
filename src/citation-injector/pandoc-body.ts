import { CitationRequest, DocumentFormat } from "./model.js";
import { unescapeXml } from "./xml-utils.js";

/**
 * Finds Pandoc-style citation markers in an already-normalized document body and turns them into neutral
 * CitationRequest, for the Pandoc branch of inject_citations. Markers are read ONLY from visible text
 * (docx `<w:t>` content, odt element content) — never from field codes (`<w:instrText>`), attributes or a
 * reference mark's CSL JSON — so a second call on a `_cited` file does not treat a "@" inside an existing
 * field (e.g. a title "Twitter: @handle") as a new citation.
 *
 * `raw` is the marker exactly as it appears in the body (XML-escaped), so the format writer's replaceTag
 * can locate and replace it; `[` `]` `@` are never XML-escaped, only prose inside a marker may carry
 * entities, which are unescaped before use.
 *
 * Bracketed forms — `[@KEY]`, `[@K1; @K2]`, `[see @KEY, p. 12]`, `-@KEY` — mark `inline: false`; a bare
 * `@KEY` / `-@KEY` marks `inline: true`. An inline that does not resolve is later kept as text with a
 * warning (not an error); an unknown bracketed key stays an error.
 */

// Bracketed citekeys: Better BibTeX keys that begin and end on an alphanumeric/underscore, with internal
// punctuation only (so a trailing sentence "." or "," is not swallowed). Zotero keys are a strict subset.
const KEY = "[A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?~/-]*[A-Za-z0-9_])?";
// Inline citekeys are conservative (no `/`, `#`, …) so paths and handles like @angular/core don't become
// one long key; whatever is captured and does not resolve is kept as text anyway.
const INLINE_KEY = "[A-Za-z0-9_](?:[A-Za-z0-9_:.-]*[A-Za-z0-9_])?";
// Inline marker: `@key` / `-@key` not preceded by a word char, `_`, `/` or `.` (so emails "a@b", paths
// "x/@y", "a.@b" and "foo_@bar" are not citations).
const INLINE_RE = new RegExp(`\\[([^\\]<]*@[^\\]<]*)\\]|(?<![A-Za-z0-9_/.])(-?)@(${INLINE_KEY})`, "g");
// Inside a bracket, a `@key` is a citation only at the start of a part or after whitespace/`;` — never after
// `/`, `_`, `.` or an alphanumeric (so a URL "http://x/@user" in a bracket is not a citation key).
const KEY_RE = new RegExp(`(^|[\\s;])(-?)@(${KEY})`);
const LOCATOR_RE = /^(?:p{1,2}\.|pp?\b|pages?\b|chap\.?|ch\.|sec\.?|§|fig\.?|no\.?|vol\.?|art\.?)/i;

/** Parse the already-unescaped inner text of a `[...]` marker into a request (one entry's prefix/locator/suffix). */
function parseBracketInner(inner: string): Omit<CitationRequest, "raw"> | null {
  const parts = inner.split(";");
  const keys: string[] = [];
  let prefix: string | undefined;
  let suffix: string | undefined;
  let locator: string | undefined;
  let suppressAuthor = false;
  for (const part of parts) {
    const mm = KEY_RE.exec(part);
    if (!mm) continue;
    const at = mm.index + mm[1].length; // position of the (optional) "-" / "@"
    keys.push(mm[3]);
    if (parts.length === 1) {
      const before = part.slice(0, at).trim();
      if (before) prefix = before;
      suppressAuthor = mm[2] === "-";
      const after = part.slice(at + mm[2].length + 1 + mm[3].length).replace(/^[.,;:]*\s*/, "").trim();
      if (after) {
        if (LOCATOR_RE.test(after)) locator = after;
        else suffix = after;
      }
    }
  }
  if (keys.length === 0) return null;
  return { keys, prefix, suffix, locator, suppressAuthor, inline: false };
}

/** Parse markers in a single visible-text string (XML-escaped), in order. */
export function parsePandocCitesInText(text: string): CitationRequest[] {
  const requests: CitationRequest[] = [];
  const re = new RegExp(INLINE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      const parsed = parseBracketInner(unescapeXml(m[1]));
      if (parsed) requests.push({ ...parsed, raw: m[0] });
    } else {
      requests.push({ keys: [m[3]], suppressAuthor: m[2] === "-", inline: true, raw: m[0] });
    }
  }
  return requests;
}

/** Visible-text segments of a body, in document order: `<w:t>` content for docx, element content for odt. */
function visibleTexts(body: string, format: DocumentFormat): string[] {
  const out: string[] = [];
  // docx: only run text (<w:t>…</w:t>) — never <w:instrText> field codes. odt: element content between
  // ">" and "<" — the CSL JSON of a reference mark lives in an attribute, so it is excluded.
  const re = format === "docx" ? /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g : />([^<]*)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

export function parsePandocCitesInBody(body: string, format: DocumentFormat): CitationRequest[] {
  const requests: CitationRequest[] = [];
  for (const text of visibleTexts(body, format)) requests.push(...parsePandocCitesInText(text));
  return requests;
}

/** Count of Pandoc markers in a body (for the mixed-document warning in the zcite branch). */
export function countPandocMarkers(body: string, format: DocumentFormat): number {
  return parsePandocCitesInBody(body, format).length;
}
