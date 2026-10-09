import { FakeHandler, FakeRequest, jsonResponse, statusResponse } from "./fake-net.js";

/**
 * Risposte in formato Zotero Web API v3, così i tool vengono esercitati con
 * il vero `zotero-api-client` (solo `fetch` è finto).
 *
 * Semantica emulata (da https://www.zotero.org/support/dev/web_api/v3/basics):
 * - richieste multi-oggetto: `limit` di default 25, massimo 100; `start` offset;
 *   header `Total-Results` e `Last-Modified-Version`
 * - `itemKey` accetta al massimo 50 chiavi
 * - scritture multi-oggetto: `{ successful, success, unchanged, failed }`
 */

export const USER_ID = "424242";
export const ZOTERO_HOST = "api.zotero.org";
export const ZBASE = `${ZOTERO_HOST}/users/${USER_ID}`;

export type ZItem = Record<string, unknown> & { key: string };

export function zoteroEntity(data: ZItem, version = 1) {
  return {
    key: data.key,
    version,
    library: { type: "user", id: Number(USER_ID), name: "tester" },
    links: {},
    meta: {},
    data: { version, ...data },
  };
}

/** Risposta GET multi-oggetto (array). */
export function zList(
  items: ZItem[],
  opts: { total?: number | null; version?: number } = {}
): Response {
  const headers: Record<string, string> = {
    "Last-Modified-Version": String(opts.version ?? 100),
  };
  const total = opts.total === undefined ? items.length : opts.total;
  if (total !== null) headers["Total-Results"] = String(total);
  return jsonResponse(items.map((i) => zoteroEntity(i)), { headers });
}

/** Risposta GET a oggetto singolo. */
export function zSingle(item: ZItem, version = 7): Response {
  return jsonResponse(zoteroEntity(item, version), {
    headers: { "Last-Modified-Version": String(version) },
  });
}

/** Risposta di errore come la restituisce l'API Zotero (text/plain). */
export function zError(status: number, text = "Zotero error"): Response {
  return statusResponse(status, text, { "Content-Type": "text/plain" });
}

/**
 * Handler GET che emula il filtro/paginazione lato server su una "libreria".
 * Supporta `itemKey`, `limit` (default 25, max 100) e `start`.
 */
export function zLibraryQuery(library: ZItem[], version = 100): FakeHandler {
  return (req: FakeRequest) => {
    const p = req.url.searchParams;
    let matched = library;
    const itemKey = p.get("itemKey");
    if (itemKey !== null) {
      const keys = itemKey.split(",").filter(Boolean);
      if (keys.length > 50) {
        return zError(400, "Too many keys in itemKey (max 50)");
      }
      const wanted = new Set(keys);
      matched = library.filter((i) => wanted.has(i.key));
    }
    const limit = Math.min(Number(p.get("limit") ?? 25), 100);
    const start = Number(p.get("start") ?? 0);
    return zList(matched.slice(start, start + limit), { total: matched.length, version });
  };
}

export interface WriteFailure {
  code: number;
  message: string;
}

/**
 * Handler POST per scritture multi-oggetto. Assegna chiavi deterministiche
 * progressive tra chiamate successive (`keys[n]` oppure `NEW00000`, `NEW00001`, ...)
 * e fa fallire gli indici (della singola richiesta) in `fail`.
 */
export function zWrite(
  opts: { keys?: string[]; fail?: Record<number, WriteFailure>; version?: number } = {}
): FakeHandler {
  let counter = 0;
  return (req: FakeRequest) => {
    const body = req.json<Record<string, unknown>[]>();
    const version = opts.version ?? 200;
    const successful: Record<string, unknown> = {};
    const success: Record<string, string> = {};
    const failed: Record<string, unknown> = {};
    body.forEach((obj, i) => {
      const n = counter++; // avanza anche per gli oggetti falliti: keys[n] = posizione globale
      const f = opts.fail?.[i];
      if (f) {
        failed[String(i)] = { key: "", code: f.code, message: f.message };
        return;
      }
      const key = opts.keys?.[n] ?? `NEW${String(n).padStart(5, "0")}`;
      success[String(i)] = key;
      successful[String(i)] = zoteroEntity({ ...obj, key } as ZItem, version);
    });
    return jsonResponse(
      { successful, success, unchanged: {}, failed },
      { headers: { "Last-Modified-Version": String(version) } }
    );
  };
}

/** 204 per DELETE riuscita. */
export function zDeleted(version = 300): Response {
  return statusResponse(204, "", { "Last-Modified-Version": String(version) });
}

// ─── Fixture ────────────────────────────────────────────────────

export function article(key: string, extra: Record<string, unknown> = {}): ZItem {
  return {
    key,
    itemType: "journalArticle",
    title: `Article ${key}`,
    creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
    date: "2023-05-01",
    dateAdded: "2024-01-01T00:00:00Z",
    DOI: `10.1000/${key.toLowerCase()}`,
    tags: [],
    collections: [],
    relations: {},
    ...extra,
  };
}

export function pdfAttachment(key: string, parentItem: string, extra: Record<string, unknown> = {}): ZItem {
  return {
    key,
    itemType: "attachment",
    parentItem,
    linkMode: "imported_url",
    title: "Full Text PDF",
    contentType: "application/pdf",
    filename: "paper.pdf",
    ...extra,
  };
}

export function collection(key: string, name: string, extra: Record<string, unknown> = {}): ZItem {
  return { key, name, parentCollection: false, relations: {}, ...extra };
}

export function manyArticles(n: number, prefix = "K"): ZItem[] {
  return Array.from({ length: n }, (_, i) => article(`${prefix}${String(i).padStart(7, "0")}`));
}
