import { CslItemData } from "../types/csl-types.js";

export interface CitationTextOptions {
  num?: string;
  locator?: string;
  prefix?: string;
  suffix?: string;
  /** Pandoc `-@K`: omette l'autore (negli stili autore-data resta solo l'anno). */
  suppressAuthor?: boolean;
}

/**
 * What differs between the author-date styles in the placeholder text, as citeproc renders them
 * with the CSL styles bundled with Zotero: "(Smith, 2023, p. 12)" in apa/harvard, "(Smith 2023, 12)"
 * in chicago; "Doe & Roe" only in apa.
 */
const AUTHOR_DATE: Record<string, { yearSep: string; and: string; pageLabel: boolean }> = {
  apa: { yearSep: ", ", and: "&", pageLabel: true },
  harvard: { yearSep: ", ", and: "and", pageLabel: true },
  chicago: { yearSep: " ", and: "and", pageLabel: false },
};

/**
 * Locator as citeproc renders a locator without label (= page): "12" → "p. 12", "12-15" → "pp. 12–15";
 * a leading "p."/"pp." written by the user is replaced, any other label ("chap. 3", "fig. 2") is kept.
 */
export function formatLocator(locator: string, pageLabel: boolean): string {
  const bare = locator.trim().replace(/^pp?\.\s*/i, "");
  if (!/^[\divxlcdm]/i.test(bare) || /^[a-z]{2,}\.?\s/i.test(bare)) return locator.trim();
  const pages = bare.replace(/(\d)\s*-+\s*(\d)/g, "$1–$2");
  if (!pageLabel) return pages;
  return `${/[–,&]/.test(pages) ? "pp." : "p."} ${pages}`;
}

/** prefix/suffix the way citeproc joins them: a space after the prefix, before a suffix that does not start with punctuation. */
function affixes(opts: CitationTextOptions): { prefix: string; suffix: string } {
  const prefix = opts.prefix?.trim() ? `${opts.prefix.trim()} ` : "";
  const s = opts.suffix?.trim() ?? "";
  const suffix = !s ? "" : /^[,;.:)\]]/.test(s) ? s : ` ${s}`;
  return { prefix, suffix };
}

/** "2,3" or "5-7" → one number per item when the count matches, otherwise undefined. */
function numbersPerItem(num: string, count: number): string[] | undefined {
  const out: string[] = [];
  for (const part of num.split(",").map((p) => p.trim())) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) out.push(String(n));
    else out.push(part);
  }
  return out.length === count ? out : undefined;
}

function numberedText(count: number, style: string, opts: CitationTextOptions): string {
  const num = opts.num ?? "?";
  const { prefix, suffix } = affixes(opts);
  // nlm-citation-sequence (vancouver) does not print locators
  const locator = opts.locator && style === "ieee" ? `, ${formatLocator(opts.locator, true)}` : "";
  if (!prefix && !suffix && !locator) return `[${num}]`;
  const perItem = numbersPerItem(num, count) ?? [num];
  // ieee: each item in its own brackets ("see [1, p. 12], see [2, p. 12]"); vancouver: one group
  if (style === "ieee") return perItem.map((n) => `${prefix}[${n}${locator}]${suffix}`).join(", ");
  return `[${perItem.map((n) => `${prefix}${n}${suffix}`).join(",")}]`;
}

export function formatCitationText(items: CslItemData[], style: string, opts: CitationTextOptions = {}): string {
  if (style === "ieee" || style === "vancouver") {
    return numberedText(items.length, style, opts);
  }

  const rules = AUTHOR_DATE[style] ?? AUTHOR_DATE.apa;
  const { prefix, suffix } = affixes(opts);
  const locator = opts.locator ? `, ${formatLocator(opts.locator, rules.pageLabel)}` : "";
  const parts = items.map((item) => {
    const authors = item.author;
    const name = (a: NonNullable<CslItemData["author"]>[number]) => a.family ?? a.literal ?? "Unknown";
    const year =
      item.issued?.["date-parts"]?.[0]?.[0]?.toString() ?? "n.d.";

    // suppress-author (pandoc -@K): solo l'anno, con eventuali locator/prefix/suffix
    if (opts.suppressAuthor) return `${prefix}${year}${locator}${suffix}`;

    let authorText: string;
    if (!authors || authors.length === 0) {
      const title = item.title;
      authorText = title
        ? title.length > 30
          ? `"${title.substring(0, 30)}..."`
          : `"${title}"`
        : "Unknown";
    } else if (authors.length > 2) {
      authorText = `${name(authors[0])} et al.`;
    } else if (authors.length === 2) {
      authorText = `${name(authors[0])} ${rules.and} ${name(authors[1])}`;
    } else {
      authorText = name(authors[0]);
    }

    return `${prefix}${authorText}${rules.yearSep}${year}${locator}${suffix}`;
  });

  return `(${parts.join("; ")})`;
}
