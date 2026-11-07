import { ZoteroItemData } from "../types/zotero-types.js";

/**
 * Shared DOI helpers used by find_duplicates and check_retractions: normalise a DOI for comparison
 * and extract the comparable DOI of a Zotero item (DOI field, or a "DOI:" line in Extra). Nothing
 * here reads the network.
 */

/** A DOI must start with "10." followed by the registrant code and a slash. */
const DOI_CORE = /10\.\d{4,9}\/\S+/;
/** A URL or "doi:" prefix in front of a DOI (any case), stripped before comparison. */
const DOI_PREFIX = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/|^doi:\s*/i;
/** A "DOI: 10.x/y" line in the item's Extra field (Zotero stores a DOI there for types without a DOI field). */
const EXTRA_DOI_LINE = /^[ \t]*DOI:[ \t]*(\S+)/im;

/**
 * Strip trailing sentence punctuation from a DOI match: ".", "," and ";" always, and a ")" only when
 * it is unbalanced (more ")" than "(") — so a DOI quoted inline ("(see 10.1000/abc)") loses the closer
 * while a DOI that really contains parentheses (10.1016/S0140-6736(97)11096-0, the SICI scheme) keeps them.
 */
function stripTrailingDoiPunctuation(doi: string): string {
  let end = doi.length;
  for (; end > 0; end--) {
    const ch = doi[end - 1];
    if (ch === "." || ch === "," || ch === ";") continue;
    if (ch === ")") {
      const head = doi.slice(0, end);
      const opens = (head.match(/\(/g) ?? []).length;
      const closes = (head.match(/\)/g) ?? []).length;
      if (closes > opens) continue;
    }
    break;
  }
  return doi.slice(0, end);
}

/**
 * Normalise a DOI for comparison: drop any https://doi.org/ (or dx.doi.org / doi:) prefix, lowercase,
 * trim trailing sentence punctuation, and keep only a value that has the DOI shape. Returns null when
 * the string carries no DOI, so callers never act on a non-DOI.
 */
export function normalizeDoi(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const stripped = raw.trim().replace(DOI_PREFIX, "");
  const match = DOI_CORE.exec(stripped);
  // Strip from the match, not the whole string: a DOI quoted inline ("see 10.1000/abc, p.5") would
  // otherwise keep the comma and never match a bare "10.1000/abc".
  return match ? stripTrailingDoiPunctuation(match[0].toLowerCase()) : null;
}

/** The comparable DOI of an item: its DOI field, else a "DOI:" line in Extra. Null when it has none. */
export function itemDoi(item: ZoteroItemData): string | null {
  const fromField = normalizeDoi(item.DOI);
  if (fromField) return fromField;
  const fromExtra = item.extra ? EXTRA_DOI_LINE.exec(item.extra) : null;
  return fromExtra ? normalizeDoi(fromExtra[1]) : null;
}
