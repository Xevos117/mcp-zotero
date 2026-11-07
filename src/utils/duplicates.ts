import { ZoteroItemData } from "../types/zotero-types.js";

/**
 * Helpers for find_duplicates: normalising titles for comparison and grouping regular items into
 * duplicate candidates by title and year. DOI normalisation and extraction live in ./doi.ts (shared
 * with check_retractions). Nothing here reads the network; the tool does the scanning.
 */

/**
 * Normalise a title for comparison: NFKD, strip diacritics, lowercase, every non-alphanumeric run
 * (of any script) to a single space, trimmed. "Café: a Review!" and "cafe a review" collapse to the
 * same string.
 */
export function normalizeTitle(title: string | undefined | null): string {
  if (!title) return "";
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * A normalised title shorter than this is too generic to group on ("note", "editorial", "reply"),
 * which would pair unrelated items; such titles are skipped in the title pass.
 */
export const MIN_TITLE_LENGTH = 10;

/**
 * CJK and Hangul titles pack a whole title into a few characters ("深度学习" is 4), so the Latin
 * threshold would drop every real duplicate; a shorter minimum applies when such a script is present.
 */
export const MIN_TITLE_LENGTH_CJK = 4;
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Whether a normalised title is long enough to group on (a lower bar for CJK/Hangul titles). */
export function isTitleLongEnough(normalizedTitle: string): boolean {
  const min = CJK_SCRIPT.test(normalizedTitle) ? MIN_TITLE_LENGTH_CJK : MIN_TITLE_LENGTH;
  return normalizedTitle.length >= min;
}

/** The 4-digit year of an item's date (Zotero dates are "2024-01-15", "2024", or free text), or null. */
export function itemYear(item: ZoteroItemData): string | null {
  const match = item.date ? /\b(\d{4})\b/.exec(item.date) : null;
  return match ? match[1] : null;
}

/**
 * Split items that share a normalised title into duplicate sub-groups by year. Two items are
 * duplicates unless both carry a year and the years differ, so:
 *  - at most one distinct year present (all same, all undated, or one year plus undated ones): one group;
 *  - several distinct years: one group per year, plus the undated items as their own group (ambiguous,
 *    so never merged into a year).
 * Callers emit only the sub-groups with 2+ items.
 */
export function titleSubgroups(items: ZoteroItemData[]): ZoteroItemData[][] {
  const years = new Set(items.map(itemYear).filter((y): y is string => y !== null));
  if (years.size <= 1) return [items];
  const byYear = new Map<string, ZoteroItemData[]>();
  for (const item of items) {
    const key = itemYear(item) ?? "";
    const bucket = byYear.get(key);
    if (bucket) bucket.push(item);
    else byYear.set(key, [item]);
  }
  return [...byYear.values()];
}
