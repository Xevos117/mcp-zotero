import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject, TestContext } from "vitest";
import { startServerProcess, call as rawCall, Spawned } from "../../e2e/server-process.js";
import { apiKey, scrub, track, unpaywallEmail, LIVE_CALL_TIMEOUT_MS } from "./env.js";
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
  const cwd = mkdtempSync(join(tmpdir(), "mzt-live-"));
  let s: Spawned;
  try {
    s = await startServerProcess({
      cwd,
      env: {
        ZOTERO_API_KEY: apiKey,
        ZOTERO_USER_ID: live.userId,
        UNSAFE_OPERATIONS: unsafe,
        ...(unpaywallEmail ? { UNPAYWALL_EMAIL: unpaywallEmail } : {}),
        ...opts.env,
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

/**
 * Caso che dipende da servizi esterni (doi.org, Crossref, Unpaywall, editori): un secondo tentativo,
 * poi skip con il motivo invece di un fallimento. Da usare solo per la parte che dipende dalla rete
 * esterna; le asserzioni sul comportamento del tool restano dentro `fn`.
 */
export async function soft(ctx: TestContext, service: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    return;
  } catch (first) {
    try {
      await fn();
      ctx.annotate(scrub(`soft: riuscito al secondo tentativo (${service}): ${message(first)}`));
      return;
    } catch (second) {
      const note = scrub(`soft: ${service} non ha risposto come atteso due volte: ${message(second)}`);
      console.warn(`[live] ${ctx.task.name}: ${note}`);
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
