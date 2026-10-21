/**
 * HTML entities in registry metadata. doi.org / Crossref return some strings HTML-escaped
 * ("Computers &amp; Operations Research"); Zotero stores what it is given, so the entity ends up in the library
 * and in every bibliography. Decoding only turns entities into the characters they stand for: the text stays
 * plain text (no HTML is parsed or built), and every output that needs escaping (the .docx XML, JSON field codes)
 * escapes it again where it is written.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g;

function fromCodePoint(cp: number): string | undefined {
  // NUL, surrogates and out-of-range values are not characters: keep the entity as it is
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
  return String.fromCodePoint(cp);
}

/**
 * Decodes HTML entities in ONE pass: the output is never scanned again, so "&amp;lt;" becomes the text "&lt;",
 * not "<". Unknown or invalid entities are left unchanged.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10)) ?? whole;
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? whole;
    return NAMED[name!.toLowerCase()] ?? whole;
  });
}

/** decodeHtmlEntities on every string inside a JSON value (keys untouched); other values are returned as they are. */
export function decodeEntitiesDeep<T>(value: T): T {
  if (typeof value === "string") return decodeHtmlEntities(value) as T;
  if (Array.isArray(value)) return value.map((v) => decodeEntitiesDeep(v)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeEntitiesDeep(v)])) as T;
  }
  return value;
}
