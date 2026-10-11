import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { TestProject } from "vitest/node";
import { ROOT } from "../e2e/server-process.js";
import {
  apiKey,
  enabled,
  safeMode,
  expectedUsername,
  groupId as requestedGroupId,
  unpaywallEmail,
  readRegistry,
  registryPath,
  softSkips,
  softSkipsPath,
  scrub,
  RUN_PREFIX,
  SENTINEL_COLLECTION,
  GROUP_NAME_PREFIX,
  STALE_AFTER_MS,
} from "./helpers/env.js";
import { ZoteroWeb } from "./helpers/zotero-web.js";
import { startFixtureServer, FixtureServer } from "./helpers/fixture-server.js";
import type { LiveInfo } from "./helpers/live.js";

/**
 * Setup e teardown globali della suite dal vivo.
 *
 * Setup: verifica la chiave (/keys/current), registra i conteggi iniziali della libreria, crea le fixture
 * della run (collezione `mzt-<runId>` + sottocollezione, item con il tag `mzt-run:<runId>` e il runId nel
 * titolo), avvia il server di fixture locale e sceglie un DOI open access piccolo.
 *
 * Teardown: cancella soltanto ciò che porta i marcatori della run (titolo con il runId, tag della run,
 * appartenenza alle collezioni della run o genitore già verificato), prima le voci e poi le collezioni,
 * perché delete_collection lascia le voci al loro posto. La pulizia degli avanzi di run vecchie parte solo
 * se esiste la collezione sentinella `__mzt_disposable__` e lo username della chiave è quello atteso.
 * Sull'account dedicato controlla che i conteggi tornino quelli iniziali; in safe mode avvisa se crescono.
 *
 * Run concorrenti sulla stessa libreria si serializzano con un lock (collezione `mzt-lock <runId>`).
 *
 * Solo pulizia (ZOTERO_LIVE_CLEANUP_ONLY=1, oppure `npm run test:live:cleanup -- [runId…]`): nessuna fixture,
 * tutti i test saltati; pulisce le run indicate in ZOTERO_LIVE_CLEANUP_RUN_IDS e quelle di cui restano in
 * `.vitest/` il marcatore `live-run-<runId>.json` o il registro `live-created-<runId>.jsonl` (run interrotte).
 */

const SETUP_BOUND_MS = 300_000;
const OA_MAX_BYTES = 2 * 1024 * 1024;
const BULK_ITEMS = 105;
// PDF piccoli (≈130 KB e ≈1.6 MB a ottobre 2026); il primo che passa il controllo HEAD viene usato
const OA_CANDIDATES = ["10.1371/journal.pcbi.1003285", "10.12688/f1000research.2-191.v1"];

interface Counts {
  topItems: number;
  items: number;
  collections: number;
  trash: number;
}

function withBound<T>(label: string, p: Promise<T>, ms = SETUP_BOUND_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: superato il bound di ${ms} ms`)), ms);
    }),
  ]);
}

async function counts(z: ZoteroWeb): Promise<Counts> {
  return {
    topItems: await z.totalResults("items/top"),
    items: await z.totalResults("items"),
    collections: await z.totalResults("collections"),
    trash: await z.totalResults("items/trash"),
  };
}

const log = (msg: string) => console.log(scrub(`[live] ${msg}`));

/** Primo DOI candidato con un PDF OA raggiungibile e non più grande di OA_MAX_BYTES. */
async function pickOaDoi(): Promise<{ doi: string | null; reason: string }> {
  if (!unpaywallEmail) return { doi: null, reason: "UNPAYWALL_EMAIL non impostata" };
  const reasons: string[] = [];
  for (const doi of OA_CANDIDATES) {
    try {
      const r = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(unpaywallEmail)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        reasons.push(`${doi}: Unpaywall ${r.status}`);
        continue;
      }
      const data = (await r.json()) as { best_oa_location?: { url_for_pdf?: string | null } | null };
      const pdf = data.best_oa_location?.url_for_pdf;
      if (!pdf) {
        reasons.push(`${doi}: nessun url_for_pdf`);
        continue;
      }
      const head = await fetch(pdf, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15_000) });
      const size = Number(head.headers.get("content-length") ?? NaN);
      const isPdf = (head.headers.get("content-type") ?? "").includes("application/pdf");
      if (head.ok && isPdf && Number.isFinite(size) && size > 0 && size <= OA_MAX_BYTES) return { doi, reason: `PDF ${size} byte` };
      reasons.push(`${doi}: HEAD ${head.status}, ${head.headers.get("content-type")}, ${Number.isFinite(size) ? `${size} byte` : "dimensione ignota"}`);
    } catch (e) {
      reasons.push(`${doi}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { doi: null, reason: scrub(reasons.join("; ")) };
}

async function seed(z: ZoteroWeb, runTag: string, prefix: string) {
  const [collection] = await z.create("collections", [{ name: prefix }]);
  const [subcollection] = await z.create("collections", [{ name: `${prefix} sub`, parentCollection: collection }]);
  const tags = [{ tag: runTag }];
  const base = { tags, collections: [collection], relations: {} };
  const items = [
    {
      ...base,
      itemType: "journalArticle",
      title: `${prefix} Article on live testing`,
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "author", firstName: "Alan", lastName: "Turing" },
      ],
      publicationTitle: "Journal of Live Tests",
      volume: "3",
      issue: "2",
      pages: "1-10",
      date: "2024-05-01",
      DOI: "10.9999/mzt.fixture",
      url: "https://example.org/mzt-article",
      abstractNote: "Fixture abstract for the live suite.",
    },
    { ...base, itemType: "book", title: `${prefix} Consortium handbook`, creators: [{ creatorType: "author", name: "Test Consortium" }], publisher: "Test Press", place: "Rome", date: "2023" },
    {
      ...base,
      itemType: "journalArticle",
      title: `${prefix} Many authors paper`,
      creators: ["Pessoa", "Sadykov", "Uchoa", "Vanderbeck"].map((lastName) => ({ creatorType: "author", firstName: "A.", lastName })),
      date: "2020-06-25",
    },
    { ...base, itemType: "document", title: `${prefix} Anonymous memo`, creators: [] },
    { ...base, itemType: "webpage", title: `${prefix} Web page`, url: "https://example.org/mzt-page", websiteTitle: "Example" },
    { ...base, collections: [subcollection], itemType: "report", title: `${prefix} Report in subcollection`, creators: [{ creatorType: "author", firstName: "Grace", lastName: "Hopper" }], date: "2022" },
  ];
  const [article, book, many, noAuthor, webpage, inSub] = await z.create("items", items);
  // >100 voci per paginazione (get_collection_items) e blocchi da 50 (get_items_details)
  const [bulkCollection] = await z.create("collections", [{ name: `${prefix} bulk` }]);
  const bulk = await z.create(
    "items",
    Array.from({ length: BULK_ITEMS }, (_, i) => ({ itemType: "book", title: `${prefix} bulk ${String(i).padStart(3, "0")}`, tags, collections: [bulkCollection] }))
  );
  return { collection, subcollection, bulkCollection, bulk, fixtures: { article, book, many, noAuthor, webpage, inSub } };
}

/** Chiavi da cancellare: tutte quelle candidate che portano un marcatore della run. */
async function verifiedRunItems(z: ZoteroWeb, runId: string, runTag: string, runCollections: Set<string>): Promise<{ keys: string[]; refused: string[] }> {
  const candidates = new Set<string>(readRegistry(runId).items);
  for (const it of await z.getAll<any>(`items?tag=${encodeURIComponent(runTag)}`)) candidates.add(it.key);
  for (const it of await z.getAll<any>(`items?q=${encodeURIComponent(runId)}&qmode=titleCreatorYear`)) candidates.add(it.key);
  for (const c of runCollections) {
    const r = await z.get<any[]>(`collections/${c}/items?limit=100`);
    if (r.status === 200) for (const it of await z.getAll<any>(`collections/${c}/items`)) candidates.add(it.key);
  }
  const data = new Map<string, any>();
  const fetchData = async (keys: string[]) => {
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const r = await z.get<any[]>(`items?itemKey=${chunk.join(",")}&includeTrashed=1&limit=50`);
      if (r.status === 200) for (const it of r.data) data.set(it.key, it.data);
    }
  };
  await fetchData([...candidates]);
  // figli (allegati creati dai tool) dei candidati
  for (const key of [...data.keys()]) {
    const r = await z.get<any[]>(`items/${key}/children?limit=100`);
    if (r.status === 200) for (const child of r.data) data.set(child.key, child.data);
  }
  const verified = new Set<string>();
  const marked = (d: any) =>
    String(d.title ?? "").includes(runId) ||
    (d.tags ?? []).some((t: { tag: string }) => t.tag === runTag) ||
    (d.collections ?? []).some((c: string) => runCollections.has(c));
  for (const [key, d] of data) if (marked(d)) verified.add(key);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, d] of data) {
      if (!verified.has(key) && d.parentItem && verified.has(d.parentItem)) {
        verified.add(key);
        changed = true;
      }
    }
  }
  const refused = [...candidates].filter((k) => data.has(k) && !verified.has(k));
  return { keys: [...verified], refused };
}

/** Collezioni della run: solo quelle con il nome `mzt-<runId>…` (anche le registrate devono averlo). */
async function runCollectionsOf(z: ZoteroWeb, prefix: string, runId: string): Promise<Array<{ key: string; name: string; parent: string | false }>> {
  const all = await z.getAll<any>("collections");
  const unnamed = readRegistry(runId).collections.filter((k) => !all.some((c) => c.key === k && String(c.data.name).startsWith(prefix)));
  if (unnamed.length) log(`teardown: ${unnamed.length} collezioni registrate senza il prefisso della run NON cancellate`);
  return all
    .filter((c) => String(c.data.name).startsWith(prefix))
    .map((c) => ({ key: c.key, name: c.data.name, parent: c.data.parentCollection }));
}

async function cleanupRun(z: ZoteroWeb, runId: string, runTag: string, prefix: string) {
  const colls = await runCollectionsOf(z, prefix, runId);
  const runCollections = new Set(colls.map((c) => c.key));
  const { keys, refused } = await verifiedRunItems(z, runId, runTag, runCollections);
  if (refused.length) log(`teardown: ${refused.length} chiavi registrate senza marcatori della run NON cancellate`);
  await z.deleteKeys("items", keys);
  // prima le sottocollezioni
  const depth = (c: { parent: string | false }): number => {
    const p = colls.find((x) => x.key === c.parent);
    return p ? 1 + depth(p) : 0;
  };
  const ordered = [...colls].sort((a, b) => depth(b) - depth(a));
  for (const c of ordered) {
    const r = await z.get(`collections/${c.key}`);
    if (r.status === 200) await z.deleteKeys("collections", [c.key]);
  }
  return { items: keys.length, collections: colls.length, refused: refused.length };
}

/** runId = `<timestamp base36>-<4 hex>` (vedi setup); il timestamp dice quando è iniziata la run. */
const RUN_ID_RE = /^([0-9a-z]{8,9})-([0-9a-f]{4})$/;
const RUN_NAME_RE = /^mzt-([0-9a-z]{8,9})-([0-9a-f]{4})(?: |$)/;
const runIdTime = (runId: string) => {
  const m = RUN_ID_RE.exec(runId);
  return m ? parseInt(m[1], 36) : NaN;
};

/**
 * Avanzi di run precedenti (> 6 h): solo sull'account dedicato, mai in safe mode. Una run è riconosciuta
 * dal nome stretto `mzt-<runId>` delle collezioni e dei titoli o dal tag `mzt-run:<runId>`; si cancellano
 * anche le voci delle sue collezioni (voci da DOI, allegati standalone) prima delle collezioni.
 */
async function sweepStale(z: ZoteroWeb) {
  const cutoff = Date.now() - STALE_AFTER_MS;
  const stale = (runId: string | undefined) => !!runId && runIdTime(runId) < cutoff;
  const nameRun = (name: string) => {
    const m = RUN_NAME_RE.exec(name);
    return m ? `${m[1]}-${m[2]}` : undefined;
  };
  const staleColls = (await z.getAll<any>("collections")).filter((c) => stale(nameRun(String(c.data.name))));
  const keys = new Set<string>();
  for (const c of staleColls) for (const it of await z.getAll<any>(`collections/${c.key}/items`)) keys.add(it.key);
  for (const it of await z.getAll<any>(`items?q=${RUN_PREFIX}&qmode=titleCreatorYear`)) {
    if (stale(nameRun(String(it.data.title ?? "")))) keys.add(it.key);
  }
  const tags = await z.getAll<any>(`tags?q=${encodeURIComponent("mzt-run:")}&qmode=startsWith`);
  for (const t of tags) {
    if (!stale(String(t.tag).slice("mzt-run:".length))) continue;
    for (const it of await z.getAll<any>(`items?tag=${encodeURIComponent(t.tag)}`)) keys.add(it.key);
  }
  if (keys.size) await z.deleteKeys("items", [...keys]);
  if (staleColls.length) await z.deleteKeys("collections", staleColls.map((c) => c.key));
  log(`pulizia avanzi: ${keys.size} voci, ${staleColls.length} collezioni più vecchie di 6 h`);
}

// ─── Lock tra run concorrenti sulla stessa libreria (anche da worktree o macchine diverse) ───
const LOCK_PREFIX = "mzt-lock ";
const LOCK_STALE_MS = 45 * 60 * 1000; // più del job CI (30 min): un lock più vecchio è di una run morta
const LOCK_WAIT_MS = 10 * 60 * 1000;

/**
 * Collezione `mzt-lock <runId>`: se esiste un lock più vecchio e non scaduto di un'altra run, si aspetta
 * (fino a 10 min) e poi si rinuncia con un errore chiaro. A parità di corsa vince il runId più vecchio.
 */
async function acquireLock(z: ZoteroWeb, runId: string): Promise<string> {
  const [lockKey] = await z.create("collections", [{ name: `${LOCK_PREFIX}${runId}` }]);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const others = (await z.getAll<any>("collections"))
      .map((c) => ({ key: c.key as string, runId: String(c.data.name).startsWith(LOCK_PREFIX) ? String(c.data.name).slice(LOCK_PREFIX.length) : "" }))
      .filter((l) => l.runId && l.key !== lockKey && Number.isFinite(runIdTime(l.runId)));
    for (const l of others.filter((o) => Date.now() - runIdTime(o.runId) > LOCK_STALE_MS)) {
      log(`lock scaduto della run ${l.runId} rimosso`);
      await z.deleteKeys("collections", [l.key]);
    }
    const older = others.filter((o) => Date.now() - runIdTime(o.runId) <= LOCK_STALE_MS && o.runId < runId);
    if (older.length === 0) return lockKey;
    if (Date.now() > deadline) {
      await z.deleteKeys("collections", [lockKey]);
      throw new Error(`un'altra run dal vivo (${older.map((o) => o.runId).join(", ")}) usa questa libreria da oltre ${LOCK_WAIT_MS / 60000} min: riprovare più tardi`);
    }
    log(`in attesa della run ${older[0].runId} sulla stessa libreria…`);
    await sleep(15_000);
  }
}

const runMarker = (runId: string) => join(ROOT, ".vitest", `live-run-${runId}.json`);

/** Run da pulire in modalità solo pulizia: quelle indicate, quelle interrotte (marcatore) e quelle con un registro. */
function runsToClean(): string[] {
  const ids = new Set((process.env.ZOTERO_LIVE_CLEANUP_RUN_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  try {
    for (const f of readdirSync(join(ROOT, ".vitest"))) {
      const m = /^live-(?:run|created)-(.+)\.jsonl?$/.exec(f);
      if (m) ids.add(m[1]);
    }
  } catch {
    // nessuna cartella .vitest: nessuna run interrotta
  }
  for (const id of ids) if (!RUN_ID_RE.test(id)) throw new Error(`runId non valido per la pulizia: ${id}`);
  return [...ids];
}

async function verifiedGroup(z: ZoteroWeb): Promise<string | null> {
  if (!requestedGroupId || safeMode) return null;
  const g = await z.get<any>(`/groups/${requestedGroupId}`);
  if (g.status === 200 && String(g.data?.data?.name ?? "").startsWith(GROUP_NAME_PREFIX)) return requestedGroupId;
  log(`gruppo ${requestedGroupId} ignorato: non accessibile o nome senza prefisso ${GROUP_NAME_PREFIX}`);
  return null;
}

/** Solo pulizia: stesse regole sui marcatori del teardown, per le run interrotte o indicate. */
async function cleanupOnly(z: ZoteroWeb, disposable: boolean): Promise<void> {
  const groupId = await verifiedGroup(z);
  const ids = runsToClean();
  if (ids.length === 0) log("pulizia: nessuna run da pulire");
  for (const runId of ids) {
    const prefix = `${RUN_PREFIX}${runId}`;
    const tag = `mzt-run:${runId}`;
    if (groupId) await withBound("pulizia gruppo", cleanupRun(z.withLibrary(`groups/${groupId}`), runId, tag, prefix));
    const removed = await withBound("pulizia", cleanupRun(z, runId, tag, prefix));
    const locks = (await z.getAll<any>("collections")).filter((c) => c.data.name === `${LOCK_PREFIX}${runId}`);
    if (locks.length) await z.deleteKeys("collections", locks.map((c) => c.key));
    const leftover = await z.totalResults(`items?tag=${encodeURIComponent(tag)}`);
    log(`pulizia run ${runId}: rimossi ${removed.items} voci e ${removed.collections} collezioni, avanzi ${leftover}`);
    if (leftover) throw new Error(`pulizia run ${runId}: restano ${leftover} voci`);
    rmSync(runMarker(runId), { force: true });
    rmSync(registryPath(runId), { force: true });
    rmSync(softSkipsPath(runId), { force: true });
  }
  if (disposable) await withBound("pulizia avanzi", sweepStale(z));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default async function setup(project: TestProject) {
  const disabled = (reason: string): LiveInfo =>
    ({ enabled: false, skipReason: reason, safeMode, runId: "", runTag: "", prefix: "", userId: "", libraryPath: "", collection: "", subcollection: "", bulkCollection: "", bulk: [], fixtures: {} as LiveInfo["fixtures"], fixtureBase: "", oaDoi: null, oaSkipReason: reason, groupId: null });
  if (!enabled) {
    project.provide("live", disabled("ZOTERO_TEST_API_KEY non impostata: suite dal vivo saltata"));
    return;
  }

  const started = Date.now();
  const runId = `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const runTag = `mzt-run:${runId}`;
  const prefix = `${RUN_PREFIX}${runId}`;
  const cleanupOnlyMode = process.env.ZOTERO_LIVE_CLEANUP_ONLY === "1";

  const keyInfo = await withBound("keys/current", new ZoteroWeb(apiKey, "").getOk<any>("/keys/current"));
  const userId = String(keyInfo.data.userID);
  const username = String(keyInfo.data.username ?? "");
  if (process.env.ZOTERO_TEST_USER_ID && process.env.ZOTERO_TEST_USER_ID !== userId) {
    throw new Error("ZOTERO_TEST_USER_ID non corrisponde all'utente della chiave: suite interrotta");
  }
  const z = new ZoteroWeb(apiKey, `users/${userId}`);
  const sentinel = (await z.getAll<any>("collections")).some((c) => c.data.name === SENTINEL_COLLECTION);
  const disposable = !safeMode && sentinel && !!expectedUsername && expectedUsername === username;
  if (cleanupOnlyMode) {
    await cleanupOnly(z, disposable);
    project.provide("live", disabled("ZOTERO_LIVE_CLEANUP_ONLY=1: solo pulizia"));
    return;
  }
  mkdirSync(join(ROOT, ".vitest"), { recursive: true });
  writeFileSync(runMarker(runId), JSON.stringify({ runId, started: new Date(started).toISOString() }));
  log(`run ${runId}: ${safeMode ? "SAFE MODE" : "modalità completa"}, account dedicato: ${disposable ? "sì" : "no"}`);
  const lockKey = await withBound("lock", acquireLock(z, runId), LOCK_WAIT_MS + 60_000);
  const releaseLock = () => z.deleteKeys("collections", [lockKey]).catch((e) => log(`lock non rimosso: ${e}`));
  try {
    if (disposable) await withBound("pulizia avanzi", sweepStale(z));
  } catch (e) {
    await releaseLock();
    throw e;
  }

  const before = await withBound("conteggi iniziali", counts(z));
  const groupId = await verifiedGroup(z);

  let fixtureServer: FixtureServer | undefined;
  try {
    const seeded = await withBound("fixture", seed(z, runTag, prefix));
    fixtureServer = await startFixtureServer();
    const oa = await withBound("DOI open access", pickOaDoi(), 60_000);
    log(`DOI OA: ${oa.doi ?? "nessuno"} (${oa.reason})`);
    project.provide("live", {
      enabled: true,
      skipReason: "",
      safeMode,
      runId,
      runTag,
      prefix,
      userId,
      libraryPath: `users/${userId}`,
      collection: seeded.collection,
      subcollection: seeded.subcollection,
      bulkCollection: seeded.bulkCollection,
      bulk: seeded.bulk,
      fixtures: seeded.fixtures,
      fixtureBase: fixtureServer.base,
      oaDoi: oa.doi,
      oaSkipReason: oa.reason,
      groupId,
    });
  } catch (e) {
    await fixtureServer?.close();
    await withBound("pulizia dopo setup fallito", cleanupRun(z, runId, runTag, prefix)).catch((err) => log(`pulizia fallita: ${err}`));
    await releaseLock();
    throw new Error(scrub(e instanceof Error ? e.message : String(e)));
  }

  return async () => {
    try {
      await teardown();
    } finally {
      await releaseLock();
    }
  };

  async function teardown() {
    await fixtureServer?.close();
    if (groupId) {
      const g = await withBound("teardown gruppo", cleanupRun(z.withLibrary(`groups/${groupId}`), runId, runTag, prefix));
      log(`teardown gruppo: rimossi ${g.items} voci e ${g.collections} collezioni`);
    }
    const removed = await withBound("teardown", cleanupRun(z, runId, runTag, prefix));
    const leftoverItems = await z.totalResults(`items?tag=${encodeURIComponent(runTag)}`);
    const leftoverColls = (await z.getAll<any>("collections")).filter((c) => String(c.data.name).startsWith(prefix)).length;
    const after = await counts(z);
    const summary = {
      runId,
      safeMode,
      disposable,
      durationSeconds: Math.round((Date.now() - started) / 1000),
      removed,
      leftover: { items: leftoverItems, collections: leftoverColls },
      before,
      after,
      fixtureBytesServed: fixtureServer?.bytesServed() ?? 0,
    };
    mkdirSync(join(ROOT, ".vitest"), { recursive: true });
    writeFileSync(join(ROOT, ".vitest", "live-summary.json"), scrub(JSON.stringify(summary, null, 2)));
    log(`teardown: rimossi ${removed.items} voci e ${removed.collections} collezioni; avanzi ${leftoverItems}/${leftoverColls}`);
    log(`conteggi prima ${JSON.stringify(before)} dopo ${JSON.stringify(after)}`);
    if (leftoverItems || leftoverColls) throw new Error(`teardown: restano ${leftoverItems} voci e ${leftoverColls} collezioni della run ${runId}`);
    rmSync(registryPath(runId), { force: true });
    rmSync(runMarker(runId), { force: true });
    const grew = (Object.keys(before) as Array<keyof Counts>).filter((k) => after[k] > before[k]);
    if (grew.length) log(`ATTENZIONE: conteggi cresciuti (${grew.join(", ")}): qualcosa creato dalla run non porta i marcatori, oppure un'altra attività sulla libreria`);
    const skips = softSkips(runId);
    rmSync(softSkipsPath(runId), { force: true });
    const maxSkips = Number(process.env.ZOTERO_LIVE_MAX_SOFT_SKIPS ?? Infinity);
    if (skips > maxSkips) throw new Error(`${skips} casi soft saltati per servizi esterni (massimo ${maxSkips})`);
    if (disposable && JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`account dedicato: conteggi non tornati a quelli iniziali (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
    }
  }
}
