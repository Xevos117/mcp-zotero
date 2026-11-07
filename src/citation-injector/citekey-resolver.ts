import { CitationRequest, InjectionError } from "./model.js";

// Same rule as ZOTERO_KEY in src/utils/zotero-keys.ts, inlined so this module (shared with the skill
// bundle) stays free of the zod import that file carries.
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/**
 * Resolution of Better BibTeX citation keys to Zotero item keys for the Pandoc branch of inject_citations.
 * A Pandoc document usually cites items by their BBT citekey (`[@rossi2020]`), not the Zotero 8-char key,
 * so those are mapped to real keys before the field codes (which embed `…/items/<KEY>` URIs) are built. An
 * 8-char Zotero key in the document is used as-is and never looked up.
 *
 * A citekey lives in the item's native `citationKey` field or, when pinned by Better BibTeX, in a
 * `Citation Key: <key>` line of Extra. Citation keys are CASE-SENSITIVE (as in BBT). The lookup is
 * injected: the server queries the Zotero API, the skill reads metadata.json.
 */

/** What a lookup found for a citekey: exact matches, and (for a helpful error) keys differing only in case. */
export interface CitekeyMatch {
  /** Zotero keys of items whose citekey matches exactly (0 = unknown, 2+ = ambiguous). */
  keys: string[];
  /** Citekeys that differ only by letter case (suggested in the "not found" error). */
  similar?: string[];
}

export type CitekeyLookup = (citekeys: Set<string>) => Promise<Map<string, CitekeyMatch>>;

/** The citekeys an item carries: the native `citationKey` field and every `Citation Key: <key>` line of Extra. */
export function itemCitekeys(item: { citationKey?: unknown; extra?: unknown }): string[] {
  const out: string[] = [];
  if (typeof item.citationKey === "string" && item.citationKey) out.push(item.citationKey);
  if (typeof item.extra === "string") {
    for (const line of item.extra.split(/\r?\n/)) {
      const m = /^[ \t]*citation ?key[ \t]*:[ \t]*(\S+)[ \t]*$/i.exec(line);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

/** Exact (case-sensitive) match of `citekey` against an item's citationKey field or Extra line. */
export function itemMatchesCitekey(item: { citationKey?: unknown; extra?: unknown }, citekey: string): boolean {
  return itemCitekeys(item).includes(citekey);
}

/** The citekeys in these requests that are not already well-formed Zotero item keys. */
export function citekeysOf(requests: CitationRequest[]): Set<string> {
  const out = new Set<string>();
  for (const r of requests) for (const k of r.keys) if (!ZOTERO_KEY.test(k)) out.add(k);
  return out;
}

export interface ResolveResult {
  /** Requests with every citekey replaced by its Zotero key; unresolved inline markers are dropped. */
  requests: CitationRequest[];
  /** One per dropped inline marker (kept as text). */
  warnings: string[];
}

/**
 * Resolve Better BibTeX citekeys to Zotero keys. An inline `@key` that does not resolve (unknown or
 * ambiguous) is DROPPED and kept as text, with a warning — a stray handle or code like `@Component` must
 * not fail the whole document. A bracketed `[@key]` that is unknown or ambiguous is an error (nothing is
 * written), the same contract as a missing Zotero key.
 *
 * Inline-only citekeys are looked up at most INLINE_LOOKUP_CAP distinct tokens per call, so a technical
 * document full of `@decorator`/`@media` does not fan out into unbounded API searches: tokens past the cap
 * are left as text with one summary warning. Zotero 8-char keys (no lookup) and bracketed `[@…]` forms (a
 * real citation) never count toward the cap.
 */
export const INLINE_LOOKUP_CAP = 25;

export async function resolveCitekeys(requests: CitationRequest[], lookup: CitekeyLookup): Promise<ResolveResult> {
  const citekeys = citekeysOf(requests);
  if (citekeys.size === 0) return { requests, warnings: [] };

  // Citekeys used by a bracketed form must always be resolved (they error if unknown); inline-only
  // citekeys are capped.
  const bracketKeys = new Set<string>();
  for (const r of requests) if (!r.inline) for (const k of r.keys) if (!ZOTERO_KEY.test(k)) bracketKeys.add(k);
  const inlineOnly = [...citekeys].filter((k) => !bracketKeys.has(k)); // first-appearance order
  const cappedOut = new Set(inlineOnly.slice(INLINE_LOOKUP_CAP));
  const toLookup = new Set([...bracketKeys, ...inlineOnly.slice(0, INLINE_LOOKUP_CAP)]);

  const found = toLookup.size > 0 ? await lookup(toLookup) : new Map();
  const status = (ck: string): { ok?: string; problem?: "unknown" | "ambiguous"; detail: string } => {
    const match = found.get(ck) ?? { keys: [] };
    if (match.keys.length === 1) return { ok: match.keys[0], detail: ck };
    if (match.keys.length === 0) {
      const sim = match.similar && match.similar.length ? ` (case-sensitive; did you mean ${match.similar.join(", ")}?)` : "";
      return { problem: "unknown", detail: `${ck}${sim}` };
    }
    return { problem: "ambiguous", detail: `${ck} → ${match.keys.join(", ")}` };
  };

  const unknownBracket: string[] = [];
  const ambiguousBracket: string[] = [];
  const warnings: string[] = [];
  const out: CitationRequest[] = [];

  for (const r of requests) {
    const resolvedKeys: string[] = [];
    let drop = false;
    for (const k of r.keys) {
      if (ZOTERO_KEY.test(k)) {
        resolvedKeys.push(k);
        continue;
      }
      if (r.inline && cappedOut.has(k)) {
        // over the inline lookup cap: left as text, no per-key lookup (summary warning added below)
        drop = true;
        break;
      }
      const s = status(k);
      if (s.ok) {
        resolvedKeys.push(s.ok);
      } else if (r.inline) {
        // an inline marker that does not resolve stays text (no error)
        drop = true;
        warnings.push(`"${r.raw}" did not match any item (citation key or Zotero key); kept as text.`);
        break;
      } else if (s.problem === "ambiguous") {
        ambiguousBracket.push(s.detail);
      } else {
        unknownBracket.push(s.detail);
      }
    }
    if (!drop && resolvedKeys.length === r.keys.length) out.push({ ...r, keys: resolvedKeys });
  }

  if (cappedOut.size > 0) {
    warnings.push(
      `${cappedOut.size} inline @ citation key(s) were left as text without a lookup (over the ${INLINE_LOOKUP_CAP}-key ` +
        "limit for inline markers); use the [@key] form for citations beyond that limit."
    );
  }

  if (unknownBracket.length > 0) {
    throw new InjectionError(
      "missing_keys",
      `${unknownBracket.length} citation key(s) not found in the library: ${unknownBracket.join("; ")}. No file was written. ` +
        "Citation keys are case-sensitive and matched against each item's citationKey field or a \"Citation Key: <key>\" line " +
        "in Extra (Better BibTeX). Fix these keys, or cite the item by its 8-character Zotero key, and call again; for a group " +
        "library pass library_type and library_id."
    );
  }
  if (ambiguousBracket.length > 0) {
    throw new InjectionError(
      "invalid_key",
      `${ambiguousBracket.length} citation key(s) match more than one item: ${ambiguousBracket.join("; ")}. No file was written. ` +
        "Make the citation key unique in Zotero, or cite the item by its 8-character Zotero key, and call again."
    );
  }

  return { requests: out, warnings };
}
