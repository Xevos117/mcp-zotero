import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject, TestContext } from "vitest";
import { startServerProcess, call as rawCall, Spawned } from "../../e2e/server-process.js";
import { apiKey, scrub, track, recordSoftSkip, unpaywallEmail, LIVE_CALL_TIMEOUT_MS } from "./env.js";
import { ZoteroWeb } from "./zotero-web.js";

/** Valori preparati da test/live/global-setup.ts e condivisi con i file di test. */
export interface LiveFixtures {
  /** journalArticle, 2 autori, 2024, DOI fittizio, URL, abstract */
  article: string;
  /** book con autore istituzionale, 2023 */
  book: string;
  /** journalArticle con 4 autori, 2020 */
  many: string;
  /** document senza autori né data */
  noAuthor: string;
  /** webpage con URL */
  webpage: string;
  /** item nella sottocollezione */
  inSub: string;
}

export interface LiveInfo {
  enabled: boolean;
  skipReason: string;
  safeMode: boolean;
  runId: string;
  /** Tag `mzt-run:<runId>` che marca tutto ciò che la run crea. */
  runTag: string;
  /** Prefisso dei titoli: `mzt-<runId>`. */
  prefix: string;
  userId: string;
  libraryPath: string;
  collection: string;
  subcollection: string;
  /** Collezione con 105 voci `book` (paginazione oltre 100, blocchi da 50). */
  bulkCollection: string;
  bulk: string[];
  fixtures: LiveFixtures;
  fixtureBase: string;
  /** DOI open access piccolo verificato in setup (null: casi OA saltati, motivo in oaSkipReason). */
  oaDoi: string | null;
  oaSkipReason: string;
  /** Gruppo di test verificato (nome con prefisso mzt-test), null se assente o in safe mode. */
  groupId: string | null;
}

declare module "vitest" {
  export interface ProvidedContext {
    live: LiveInfo;
  }
}

export const live: LiveInfo = inject("live");

export function web(): ZoteroWeb {
  return new ZoteroWeb(apiKey, live.libraryPath);
}

export interface CallResult {
  isError: boolean;
  text: string;
  json: any;
}

export interface LiveServer {
  call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<CallResult>;
  listTools(): Promise<Array<{ name: string }>>;
  stderr(): string;
  close(): Promise<void>;
}

/**
 * Avvia build/server.js con la chiave di test (mappata su ZOTERO_API_KEY solo nell'ambiente del figlio),
 * in una cartella temporanea vuota (dotenv non trova nulla) e con UNSAFE_OPERATIONS esplicito.
 */
export async function startLive(opts: { unsafe?: "none" | "items" | "all"; env?: Record<string, string> } = {}): Promise<LiveServer> {
  const unsafe = opts.unsafe ?? "none";
  if (live.safeMode && unsafe === "all") throw new Error("safe mode: UNSAFE_OPERATIONS=all non ammesso");
  const reserved = Object.keys(opts.env ?? {}).filter((k) => ["ZOTERO_API_KEY", "ZOTERO_USER_ID", "UNSAFE_OPERATIONS"].includes(k));
  if (reserved.length) throw new Error(`startLive: env non può sovrascrivere ${reserved.join(", ")}`);
  const cwd = mkdtempSync(join(tmpdir(), "mzt-live-"));
  let s: Spawned;
  try {
    s = await startServerProcess({
      cwd,
      env: {
        ...opts.env,
        ...(unpaywallEmail ? { UNPAYWALL_EMAIL: unpaywallEmail } : {}),
        // dopo opts.env: chiave, utente e guardia sulle cancellazioni non sono sovrascrivibili
        ZOTERO_API_KEY: apiKey,
        ZOTERO_USER_ID: live.userId,
        UNSAFE_OPERATIONS: unsafe,
      },
      connectTimeoutMs: 30_000,
      callTimeoutMs: LIVE_CALL_TIMEOUT_MS,
    });
  } catch (e) {
    rmSync(cwd, { recursive: true, force: true });
    throw new Error(scrub(e instanceof Error ? e.message : String(e)));
  }
  return {
    async call(name, args, timeoutMs) {
      const r = await rawCall(s, name, args, timeoutMs);
      return { ...r, text: scrub(r.text) };
    },
    async listTools() {
      return (await s.client.listTools(undefined, { timeout: 30_000 })).tools;
    },
    stderr: () => scrub(s.stderr()),
    async close() {
      await s.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Registra per il teardown le chiavi create da un risultato di tool (item, allegati, collezioni). */
export function trackItems(...keys: Array<string | undefined | null>): void {
  track(live.runId, "item", ...keys);
}
export function trackCollections(...keys: Array<string | undefined | null>): void {
  track(live.runId, "collection", ...keys);
}

/** Titolo marcato con la run, così ricerche e pulizia restano deterministiche. */
export function title(label: string): string {
  return `${live.prefix} ${label}`;
}

/** Chiavi che non possono esistere: le chiavi Zotero non usano 0, 1 e O. */
export const FAKE_KEY = "ZZZZZZZ0";
export const FAKE_KEY_2 = "YYYYYYY1";

/** Guasto di un servizio esterno (doi.org, Crossref, Unpaywall, editori, rete): l'unico motivo di skip in soft(). */
export class ExternalServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalServiceError";
  }
}

const EXTERNAL_PATTERNS = [
  /DOI resolution failed for [^"\n]*?: (?:429|5\d\d)\b/,
  /timed out after/i,
  /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i,
  /Download failed for all \d+ URL/,
  /(?:status|HTTP) (?:50[234]|429)\b/,
];

/** Motivo per cui il risultato di un tool indica un guasto esterno, o null. */
export function externalFailure(r: CallResult): string | null {
  const hit = EXTERNAL_PATTERNS.find((re) => re.test(r.text));
  return hit ? (r.text.match(hit)?.[0] ?? "external failure") : null;
}

/** Da chiamare subito dopo il tool, prima delle asserzioni: un guasto esterno diventa ExternalServiceError. */
export function assertNotExternal(r: CallResult, service: string): void {
  const reason = externalFailure(r);
  if (reason) throw new ExternalServiceError(`${service}: ${reason}`);
}

/** Verifica diretta che un servizio esterno risponda (rete, 429 o 5xx → ExternalServiceError). */
export async function probe(url: string, service: string, init: RequestInit = {}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ExternalServiceError(`${service} non raggiungibile: ${message(e)}`);
  }
  await res.arrayBuffer().catch(() => undefined);
  if (res.status === 429 || res.status >= 500) throw new ExternalServiceError(`${service}: HTTP ${res.status}`);
}

/**
 * Caso che dipende da servizi esterni: si ritenta una volta e si salta (con il motivo) solo se l'errore è
 * un ExternalServiceError, cioè un guasto della rete o del servizio (vedi assertNotExternal/probe). Ogni
 * altro errore, asserzioni comprese, fa fallire il test: una regressione del tool non diventa mai uno skip.
 * Gli skip vengono contati (`.vitest/live-soft-<runId>.jsonl`): oltre ZOTERO_LIVE_MAX_SOFT_SKIPS il teardown fallisce.
 */
export async function soft(ctx: TestContext, service: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    return;
  } catch (first) {
    if (!(first instanceof ExternalServiceError)) throw first;
    try {
      await fn();
      ctx.annotate(scrub(`soft: riuscito al secondo tentativo (${service}): ${message(first)}`));
      return;
    } catch (second) {
      if (!(second instanceof ExternalServiceError)) throw second;
      const note = scrub(`soft: ${service} non disponibile due volte: ${message(second)}`);
      console.warn(`[live] ${ctx.task.name}: ${note}`);
      recordSoftSkip(live.runId, ctx.task.name, note);
      ctx.skip(note);
    }
  }
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
}

/** Crea voci proprie della run via Web API (tag della run aggiunto, chiavi registrate per il teardown). */
export async function createItems(objects: Array<Record<string, unknown>>): Promise<string[]> {
  const tagged = objects.map((o) => ({ ...o, tags: [...((o.tags as unknown[]) ?? []), { tag: live.runTag }] }));
  const keys = await web().create("items", tagged);
  trackItems(...keys);
  return keys;
}

/** Crea una collezione della run (nome `mzt-<runId> <label>`). */
export async function createCollection(label: string, parentCollection?: string): Promise<string> {
  const [key] = await web().create("collections", [{ name: title(label), ...(parentCollection ? { parentCollection } : {}) }]);
  trackCollections(key);
  return key;
}

/** Dati grezzi di una voce dalla Web API (null se 404). */
export async function rawItem(key: string): Promise<Record<string, any> | null> {
  const r = await web().get(`items/${key}`);
  return r.status === 200 ? r.data.data : null;
}

export async function rawChildren(key: string): Promise<Array<Record<string, any>>> {
  const r = await web().getOk<any[]>(`items/${key}/children?limit=100`);
  return r.data.map((c) => c.data);
}
