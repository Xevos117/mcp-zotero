import { CitationRequest, InjectionError } from "./model.js";

// Same rule as ZOTERO_KEY in src/utils/zotero-keys.ts, inlined so this module (shared with the skill
// bundle) stays free of the zod import that file carries.
const ZOTERO_KEY = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/;

/**
 * Resolution of Better BibTeX citation keys to Zotero item keys for the Pandoc branch of inject_citations.
 * A Pandoc document usually cites items by their BBT citekey (`[@rossi2020]`), not by the Zotero 8-char
 * key, so those must be mapped to real keys before the field codes (which embed `…/items/<KEY>` URIs) can
 * be built. An 8-char Zotero key in the document is used as-is and never looked up.
 *
 * A citekey lives either in the item's native `citationKey` field (exposed by the Web API) or, when pinned
 * by Better BibTeX, in a `Citation Key: <key>` line of the Extra field. The lookup is injected: the server
 * queries the Zotero API, the skill reads metadata.json.
 */

/** Maps each requested citekey to the Zotero key(s) that carry it (0 = unknown, 2+ = ambiguous). */
export type CitekeyLookup = (citekeys: Set<string>) => Promise<Map<string, string[]>>;

/** A `citationKey` field match, or a `Citation Key: <key>` line in Extra (BBT also writes "Citationkey"). */
export function itemMatchesCitekey(
  item: { citationKey?: unknown; extra?: unknown },
  citekey: string
): boolean {
  if (typeof item.citationKey === "string" && item.citationKey === citekey) return true;
  if (typeof item.extra === "string") {
    const re = /^[ \t]*citation ?key[ \t]*:[ \t]*(\S+)[ \t]*$/im;
    let m: RegExpExecArray | null;
    const byLine = item.extra.split(/\r?\n/);
    for (const line of byLine) {
      m = re.exec(line);
      if (m && m[1] === citekey) return true;
    }
  }
  return false;
}

/** The citekeys in these requests that are not already well-formed Zotero item keys. */
export function citekeysOf(requests: CitationRequest[]): Set<string> {
  const out = new Set<string>();
  for (const r of requests) for (const k of r.keys) if (!ZOTERO_KEY.test(k)) out.add(k);
  return out;
}

/**
 * Returns the requests with every Better BibTeX citekey replaced by its Zotero item key. Throws
 * InjectionError (nothing is written) when a citekey matches no item or matches more than one — the same
 * "fix the keys and call again" contract as a missing Zotero key.
 */
export async function resolveCitekeys(
  requests: CitationRequest[],
  lookup: CitekeyLookup
): Promise<CitationRequest[]> {
  const citekeys = citekeysOf(requests);
  if (citekeys.size === 0) return requests;

  const found = await lookup(citekeys);
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  const map = new Map<string, string>();
  for (const ck of citekeys) {
    const keys = found.get(ck) ?? [];
    if (keys.length === 0) unknown.push(ck);
    else if (keys.length > 1) ambiguous.push(`${ck} → ${keys.join(", ")}`);
    else map.set(ck, keys[0]);
  }

  if (unknown.length > 0) {
    throw new InjectionError(
      "missing_keys",
      `${unknown.length} citation key(s) not found in the library: ${unknown.join(", ")}. No file was written. ` +
        "Pandoc citation keys are matched against each item's citationKey field or a \"Citation Key: <key>\" line in " +
        "Extra (Better BibTeX). Fix these keys, or cite the item by its 8-character Zotero key, and call again; for a " +
        "group library pass library_type and library_id."
    );
  }
  if (ambiguous.length > 0) {
    throw new InjectionError(
      "invalid_key",
      `${ambiguous.length} citation key(s) match more than one item: ${ambiguous.join("; ")}. No file was written. ` +
        "Make the citation key unique in Zotero, or cite the item by its 8-character Zotero key, and call again."
    );
  }

  return requests.map((r) => ({ ...r, keys: r.keys.map((k) => map.get(k) ?? k) }));
}
