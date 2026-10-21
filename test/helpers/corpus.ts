import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeNet, binaryResponse, jsonResponse, statusResponse } from "./fake-net.js";
import { ZBASE, ZItem, zError, zLibraryQuery, zList, zSingle } from "./zotero-fake.js";

/**
 * Real open-licensed corpus (test/fixtures/corpus/, recorded by scripts/record-corpus.mjs): the recorded
 * responses of doi.org, Unpaywall and the publishers' PDF URLs become FakeNet routes, so add_items_by_doi,
 * find_and_attach_pdfs and inject_citations run their real code path on real registry data, never on the network.
 * `library.json` is the curated Zotero version of the same works (what a correct import gives).
 */

export const CORPUS_DIR = fileURLToPath(new URL("../fixtures/corpus/", import.meta.url));

export interface CorpusWork {
  id: string;
  key: string;
  itemType: string;
  cases: string[];
  collections: string[];
  tags: string[];
  sources: { doi?: string; containerDoi?: string; unpaywall?: boolean; datacite?: boolean; zenodo?: string; arxiv?: string; thoth?: string };
  licence: { id: string; url: string; verifiedAt: string; statement: string };
  sameYearAs?: string;
  pdf: { url: string; sha256: string; bytes: number } | null;
}

export interface CorpusManifest {
  recordedOn: string;
  collections: Array<{ key: string; name: string }>;
  works: CorpusWork[];
}

export interface CassetteEntry {
  request: { method: string; url: string; accept?: string; body?: unknown };
  response: { status: number; contentType: string; body?: unknown; bodyFile?: string };
}

export interface CorpusLibrary {
  collections: ZItem[];
  items: ZItem[];
}

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(`${CORPUS_DIR}${rel}`, "utf8")) as T;

export const corpusManifest = (): CorpusManifest => readJson<CorpusManifest>("corpus.json");
export const corpusLibrary = (): CorpusLibrary => readJson<CorpusLibrary>("library.json");

export function corpusWork(id: string): CorpusWork {
  const w = corpusManifest().works.find((x) => x.id === id);
  if (!w) throw new Error(`corpus: no work ${id}`);
  return w;
}

/** Curated library item of a work. */
export function corpusItem(id: string): ZItem {
  const key = corpusWork(id).key;
  return corpusLibrary().items.find((i) => i.key === key)!;
}

export function corpusCassette(id: string): CassetteEntry[] {
  const w = corpusWork(id);
  return Object.values(w.sources).some(Boolean) ? readJson<CassetteEntry[]>(`cassettes/${id}.json`) : [];
}

export function corpusPdf(id: string): Buffer {
  return readFileSync(`${CORPUS_DIR}pdfs/${id}.pdf`);
}

/** Works with a DOI (the ones add_items_by_doi can import). */
export const corpusDois = (): string[] => corpusManifest().works.flatMap((w) => (w.sources.doi ? [w.sources.doi] : []));

function replay(entry: CassetteEntry): Response {
  const { status, contentType, body, bodyFile } = entry.response;
  if (bodyFile) return binaryResponse(readFileSync(`${CORPUS_DIR}${bodyFile}`), contentType, status);
  if (typeof body === "string") return new Response(body, { status, headers: { "Content-Type": contentType } });
  return jsonResponse(body, { status, headers: { "Content-Type": contentType } });
}

const doiOf = (pathname: string, prefix: string) => decodeURIComponent(pathname.slice(prefix.length)).toLowerCase();

export interface CorpusRoutes {
  /** Recorded entries by "METHOD url". */
  entries: Map<string, CassetteEntry>;
}

/**
 * Registers the corpus cassettes as FakeNet routes:
 * - doi.org/<DOI> (any case, encoded or not): the recorded CSL-JSON when the request asks for the recorded
 *   Accept type (406 otherwise, as content negotiation would fail), 404 "DOI Not Found" for any other DOI;
 * - api.unpaywall.org/v2/<DOI>: the recorded response (the recorded URL carries no email), 404 for others;
 * - every other recorded URL (PDFs, registry records) by host + path.
 * `only` restricts the routes to some works.
 */
export function corpusRoutes(net: FakeNet, opts: { only?: string[] } = {}): CorpusRoutes {
  const works = corpusManifest().works.filter((w) => !opts.only || opts.only.includes(w.id));
  const entries = new Map<string, CassetteEntry>();
  const dois = new Map<string, CassetteEntry>();
  const unpaywall = new Map<string, CassetteEntry>();
  for (const w of works) {
    for (const e of corpusCassette(w.id)) {
      const u = new URL(e.request.url);
      entries.set(`${e.request.method} ${e.request.url}`, e);
      if (u.host === "doi.org") dois.set(doiOf(u.pathname, "/"), e);
      else if (u.host === "api.unpaywall.org") unpaywall.set(doiOf(u.pathname, "/v2/"), e);
      else net.on(e.request.method, `${u.host}${u.pathname}`, () => replay(e));
    }
  }
  net.on("GET", /^doi\.org\/.+/, (req) => {
    const e = dois.get(doiOf(req.url.pathname, "/"));
    if (!e) return statusResponse(404, "DOI Not Found", { "Content-Type": "text/html" });
    const accept = req.headers.get("accept") ?? "";
    if (e.request.accept && !accept.includes(e.request.accept)) return statusResponse(406, "Not Acceptable");
    return replay(e);
  });
  net.on("GET", /^api\.unpaywall\.org\/v2\/.+/, (req) => {
    const e = unpaywall.get(doiOf(req.url.pathname, "/v2/"));
    if (!e) return jsonResponse({ HTTP_status_code: 404, error: true, message: "not found" }, { status: 404 });
    return replay(e);
  });
  return { entries };
}

/**
 * The curated corpus library as a Zotero Web API library at `base` (default the test user library):
 * GET /items/<key>, GET /items (itemKey, limit, start), GET /items/<key>/children (none), GET /collections,
 * GET /collections/<key>/items.
 */
export function serveCorpusLibrary(net: FakeNet, base = ZBASE, library: CorpusLibrary = corpusLibrary()): void {
  const esc = base.replace(/\./g, "\\.");
  net.on("GET", `${base}/items`, zLibraryQuery(library.items));
  net.on("GET", new RegExp(`^${esc}/items/[A-Z0-9]+$`), (req) => {
    const key = req.url.pathname.split("/").pop()!;
    const item = library.items.find((i) => i.key === key);
    return item ? zSingle(item) : zError(404, "Item not found");
  });
  // the curated library has no attachments or notes
  net.on("GET", new RegExp(`^${esc}/items/[A-Z0-9]+/children$`), () => zList([]));
  net.on("GET", `${base}/collections`, () => zList(library.collections));
  net.on("GET", new RegExp(`^${esc}/collections/[A-Z0-9]+/items(/top)?$`), (req) => {
    const key = req.url.pathname.split("/")[req.url.pathname.split("/").indexOf("collections") + 1];
    if (!library.collections.some((c) => c.key === key)) return zError(404, "Collection not found");
    return zLibraryQuery(library.items.filter((i) => (i.collections as string[]).includes(key)))(req, 0);
  });
}
