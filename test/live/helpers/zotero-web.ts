import { REQUEST_TIMEOUT_MS, scrub } from "./env.js";

/**
 * Client minimale della Web API Zotero v3, indipendente dal codice del server: serve a preparare le
 * fixture, a verificare dall'esterno ciò che i tool dichiarano e a pulire. Ogni richiesta ha un timeout;
 * 429/500/502/503/504 vengono ritentati rispettando Retry-After, e Backoff viene onorato prima della
 * richiesta dopo.
 */

const API = "https://api.zotero.org";
const MAX_ATTEMPTS = 5;

export interface ZResponse<T = any> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

export class ZoteroWeb {
  private backoffUntil = 0;

  constructor(
    private readonly key: string,
    /** "users/<id>" o "groups/<id>" */
    public readonly libraryPath: string
  ) {}

  withLibrary(libraryPath: string): ZoteroWeb {
    return new ZoteroWeb(this.key, libraryPath);
  }

  /** Richiesta grezza; `path` relativo alla libreria se non inizia con "/". */
  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ZResponse<T>> {
    const url = path.startsWith("/") ? `${API}${path}` : `${API}/${this.libraryPath}/${path}`;
    for (let attempt = 1; ; attempt++) {
      const wait = this.backoffUntil - Date.now();
      if (wait > 0) await sleep(Math.min(wait, 60_000));
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            "Zotero-API-Key": this.key,
            "Zotero-API-Version": "3",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(scrub(`${method} ${path}: ${e instanceof Error ? e.message : String(e)}`));
        await sleep(1000 * attempt);
        continue;
      }
      const backoff = Number(res.headers.get("backoff") ?? 0);
      if (backoff > 0) this.backoffUntil = Date.now() + backoff * 1000;
      // 429/503 con Retry-After; 500/502/504 sono errori transitori dei server Zotero
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        await res.arrayBuffer().catch(() => undefined);
        await sleep(Math.min(Math.max(retryAfter, attempt * 2), 60) * 1000);
        continue;
      }
      const text = await res.text();
      let data: any = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = undefined;
      }
      return { status: res.status, headers: res.headers, data, text };
    }
  }

  async get<T = any>(path: string): Promise<ZResponse<T>> {
    return this.request<T>("GET", path);
  }

  /** GET che deve riuscire (2xx), altrimenti errore con status e testo. */
  async getOk<T = any>(path: string): Promise<ZResponse<T>> {
    const r = await this.get<T>(path);
    if (r.status < 200 || r.status >= 300) throw new Error(scrub(`GET ${path} → ${r.status} ${r.text.slice(0, 200)}`));
    return r;
  }

  /** Tutte le pagine di una lista (limit 100). */
  async getAll<T = any>(path: string, max = 5000): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let start = 0; start < max; start += 100) {
      const r = await this.getOk<T[]>(`${path}${sep}limit=100&start=${start}`);
      out.push(...r.data);
      const total = Number(r.headers.get("total-results") ?? r.data.length);
      if (r.data.length < 100 || out.length >= total) break;
    }
    return out;
  }

  async totalResults(path: string): Promise<number> {
    const sep = path.includes("?") ? "&" : "?";
    const r = await this.getOk(`${path}${sep}limit=1&format=keys`);
    return Number(r.headers.get("total-results"));
  }

  async libraryVersion(): Promise<number> {
    const r = await this.getOk("items?limit=1&format=keys");
    return Number(r.headers.get("last-modified-version"));
  }

  /** POST di oggetti (item o collezioni) in blocchi da 50; restituisce le chiavi nell'ordine dell'input. */
  async create(kind: "items" | "collections", objects: Array<Record<string, unknown>>): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < objects.length; i += 50) {
      const chunk = objects.slice(i, i + 50);
      const r = await this.request("POST", kind, chunk);
      if (r.status !== 200) throw new Error(scrub(`POST ${kind} → ${r.status} ${r.text.slice(0, 300)}`));
      const failed = r.data?.failed ?? {};
      if (Object.keys(failed).length) throw new Error(scrub(`POST ${kind}: failed ${JSON.stringify(failed)}`));
      chunk.forEach((_, idx) => keys.push(r.data.successful[String(idx)].key));
    }
    return keys;
  }

  /**
   * DELETE definitivo (non cestino) in blocchi da 50 con If-Unmodified-Since-Version; su 412 rilegge la
   * versione e riprova. Il chiamante è responsabile di passare solo chiavi verificate.
   */
  async deleteKeys(kind: "items" | "collections", keys: string[]): Promise<void> {
    const param = kind === "items" ? "itemKey" : "collectionKey";
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      for (let attempt = 1; ; attempt++) {
        const version = await this.libraryVersion();
        const r = await this.request("DELETE", `${kind}?${param}=${chunk.join(",")}`, undefined, {
          "If-Unmodified-Since-Version": String(version),
        });
        if (r.status === 204) break;
        // 412: la libreria è cambiata tra la lettura della versione e il DELETE (altra attività): ritenta con jitter
        if (r.status === 412 && attempt < 8) {
          await sleep(250 * attempt + Math.floor(Math.random() * 500));
          continue;
        }
        throw new Error(scrub(`DELETE ${kind} → ${r.status} ${r.text.slice(0, 200)}`));
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ripete `fn` finché `done` è vero o scade il bound (indicizzazione/ricerca lato server non istantanea). */
export async function poll<T>(fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000, everyMs = 1_500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() >= deadline) return v;
    await sleep(everyMs);
  }
}
