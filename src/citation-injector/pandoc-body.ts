import { CitationRequest } from "./model.js";
import { unescapeXml } from "./xml-utils.js";

/**
 * Finds Pandoc-style citation markers in an already-normalized document body and turns them into neutral
 * CitationRequest, for the Pandoc branch of inject_citations. Unlike parseCites (which works on plain
 * Markdown for create_cited_document), this works on the XML-escaped body (word/document.xml,
 * content.xml), so `raw` is the marker exactly as it appears there and the format writer's replaceTag can
 * locate and replace it. The brackets `[` `]` and `@` are never XML-escaped, so they appear verbatim;
 * only the prose inside a marker (prefix/suffix) may carry entities, which are unescaped before use.
 *
 * Supported: `[@KEY]`, `[@K1; @K2]`, `[see @KEY, p. 12]`, `-@KEY`, inline `@KEY`. KEY is either a Zotero
 * 8-char key or a Better BibTeX citation key; keys are not validated here (the resolver does that with a
 * clear error, exactly like inject_citations' key checks).
 *
 * The regex only ever matches inside text, not inside tags: a bracket body excludes `<` (so it cannot span
 * a tag), and an inline key is taken only when not preceded by an alphanumeric (so "a@b.com" is not a
 * citation). docx/odt never put `[` or a bare `@` inside markup, so markers are text-only in practice.
 */

// Better BibTeX citekeys begin with a letter/digit/underscore and may contain internal punctuation, but do
// not end with it (Pandoc treats trailing punctuation, e.g. a sentence "." or ",", as text, not key). So
// the key starts and ends on an alphanumeric/underscore, with the punctuation set only in between. Zotero
// 8-char keys are a strict subset.
const KEY = "[A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?~/-]*[A-Za-z0-9_])?";
const INLINE_RE = new RegExp(`\\[([^\\]<]*@[^\\]<]*)\\]|(?<![A-Za-z0-9])(-?)@(${KEY})`, "g");
const KEY_RE = new RegExp(`(-?)@(${KEY})`);
const LOCATOR_RE = /^(?:p{1,2}\.|pp?\b|pages?\b|chap\.?|ch\.|sec\.?|§|fig\.?|no\.?|vol\.?|art\.?)/i;

/** Trim trailing punctuation Pandoc does not treat as part of a citekey (e.g. "@smith2020." → "smith2020"). */
function trimKey(key: string): string {
  return key.replace(/[.,;:!?]+$/, "");
}

/** Parse the already-unescaped inner text of a `[...]` marker into a request (prefix/locator/suffix for one entry). */
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
    keys.push(trimKey(mm[2]));
    if (parts.length === 1) {
      const before = part.slice(0, mm.index).trim();
      if (before) prefix = before;
      suppressAuthor = mm[1] === "-";
      const after = part.slice(mm.index + mm[0].length).replace(/^[.,;:]*\s*/, "").trim();
      if (after) {
        if (LOCATOR_RE.test(after)) locator = after;
        else suffix = after;
      }
    }
  }
  if (keys.length === 0) return null;
  return { keys, prefix, suffix, locator, suppressAuthor };
}

/**
 * Count of Pandoc markers present in a body (for the mixed-document warning in the zcite branch), without
 * building requests. A marker is a bracketed `[…@…]` with a resolvable key, or an inline `@key`.
 */
export function countPandocMarkers(body: string): number {
  return parsePandocCitesInBody(body).length;
}

export function parsePandocCitesInBody(body: string): CitationRequest[] {
  const requests: CitationRequest[] = [];
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(body)) !== null) {
    if (m[1] !== undefined) {
      const parsed = parseBracketInner(unescapeXml(m[1]));
      if (parsed) requests.push({ ...parsed, raw: m[0] });
    } else {
      requests.push({ keys: [trimKey(m[3])], suppressAuthor: m[2] === "-", raw: m[0] });
    }
  }
  return requests;
}
