import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../e2e/server-process.js";

/**
 * Configurazione della suite dal vivo, letta solo da variabili ZOTERO_TEST_* (mai da ZOTERO_API_KEY,
 * che in sviluppo può puntare a una libreria reale). Senza ZOTERO_TEST_API_KEY la suite viene saltata.
 *
 * - ZOTERO_TEST_API_KEY   chiave dell'account di test (passata al server come ZOTERO_API_KEY solo nel figlio)
 * - ZOTERO_TEST_USER_ID   id utente atteso (verificato contro /keys/current; se assente si usa quello della chiave)
 * - ZOTERO_TEST_USERNAME  username atteso: abilita la pulizia degli avanzi solo se coincide e c'è la sentinella
 * - ZOTERO_TEST_GROUP_ID  gruppo per i casi di scrittura di gruppo (il nome deve iniziare con "mzt-test")
 * - UNPAYWALL_EMAIL       email reale per Unpaywall (casi open access; senza, quei casi vengono saltati)
 * - ZOTERO_LIVE_SAFE_MODE=1  libreria personale: UNSAFE_OPERATIONS al massimo "items", niente
 *                            delete_collection via MCP, niente gruppi, niente pulizia degli avanzi
 */

export const RUN_PREFIX = "mzt-";
export const SENTINEL_COLLECTION = "__mzt_disposable__";
export const GROUP_NAME_PREFIX = "mzt-test";
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Bound di una tools/call dal vivo (download PDF, Unpaywall, upload). */
export const LIVE_CALL_TIMEOUT_MS = 90_000;

export const apiKey = process.env.ZOTERO_TEST_API_KEY ?? "";
export const enabled = apiKey.length > 0;
export const safeMode = process.env.ZOTERO_LIVE_SAFE_MODE === "1";
export const unpaywallEmail = process.env.UNPAYWALL_EMAIL || undefined;
export const expectedUsername = process.env.ZOTERO_TEST_USERNAME || undefined;
export const groupId = process.env.ZOTERO_TEST_GROUP_ID || undefined;

const SECRETS = [apiKey, unpaywallEmail].filter((s): s is string => !!s && s.length >= 4);

/** Rimuove chiave ed email da qualsiasi testo destinato a log, report o messaggi di errore. */
export function scrub(text: unknown): string {
  let out = typeof text === "string" ? text : JSON.stringify(text) ?? String(text);
  for (const s of SECRETS) out = out.split(s).join("***");
  return out;
}

/**
 * Registro delle chiavi create dai test (JSONL, un file per run): il teardown globale cancella anche
 * queste, ma solo dopo aver verificato che portino i marcatori della run.
 */
export function registryPath(runId: string): string {
  return join(ROOT, ".vitest", `live-created-${runId}.jsonl`);
}

export function track(runId: string, kind: "item" | "collection", ...keys: Array<string | undefined | null>): void {
  const valid = keys.filter((k): k is string => typeof k === "string" && /^[A-Z0-9]{8}$/.test(k));
  if (!valid.length) return;
  mkdirSync(join(ROOT, ".vitest"), { recursive: true });
  appendFileSync(registryPath(runId), valid.map((key) => JSON.stringify({ kind, key }) + "\n").join(""));
}

export function readRegistry(runId: string): { items: string[]; collections: string[] } {
  const out = { items: new Set<string>(), collections: new Set<string>() };
  const p = registryPath(runId);
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
      const { kind, key } = JSON.parse(line) as { kind: string; key: string };
      (kind === "collection" ? out.collections : out.items).add(key);
    }
  }
  return { items: [...out.items], collections: [...out.collections] };
}
