import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
 * Sull'account dedicato controlla che i conteggi tornino quelli iniziali.
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

/** Avanzi di run precedenti (> 6 h): solo sull'account dedicato, mai in safe mode. */
async function sweepStale(z: ZoteroWeb) {
  const cutoff = Date.now() - STALE_AFTER_MS;
  const runTime = (name: string) => {
    const m = /^mzt-([0-9a-z]+)-[0-9a-f]+/.exec(name);
    return m ? parseInt(m[1], 36) : NaN;
  };
  const colls = (await z.getAll<any>("collections")).filter((c) => runTime(String(c.data.name)) < cutoff);
  const items = (await z.getAll<any>(`items?q=${RUN_PREFIX}&qmode=titleCreatorYear`)).filter(
    (it) => String(it.data.title ?? "").startsWith(RUN_PREFIX) && Date.parse(it.data.dateAdded) < cutoff
  );
  if (items.length) await z.deleteKeys("items", items.map((i) => i.key));
  if (colls.length) await z.deleteKeys("collections", colls.map((c) => c.key));
  log(`pulizia avanzi: ${items.length} voci, ${colls.length} collezioni più vecchie di 6 h`);
}

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

  const keyInfo = await withBound("keys/current", new ZoteroWeb(apiKey, "").getOk<any>("/keys/current"));
  const userId = String(keyInfo.data.userID);
  const username = String(keyInfo.data.username ?? "");
  if (process.env.ZOTERO_TEST_USER_ID && process.env.ZOTERO_TEST_USER_ID !== userId) {
    throw new Error("ZOTERO_TEST_USER_ID non corrisponde all'utente della chiave: suite interrotta");
  }
  const z = new ZoteroWeb(apiKey, `users/${userId}`);
  const sentinel = (await z.getAll<any>("collections")).some((c) => c.data.name === SENTINEL_COLLECTION);
  const disposable = !safeMode && sentinel && !!expectedUsername && expectedUsername === username;
  log(`run ${runId}: ${safeMode ? "SAFE MODE" : "modalità completa"}, account dedicato: ${disposable ? "sì" : "no"}`);
  if (disposable) await withBound("pulizia avanzi", sweepStale(z));

  const before = await withBound("conteggi iniziali", counts(z));

  let groupId: string | null = null;
  if (requestedGroupId && !safeMode) {
    const g = await z.get<any>(`/groups/${requestedGroupId}`);
    if (g.status === 200 && String(g.data?.data?.name ?? "").startsWith(GROUP_NAME_PREFIX)) groupId = requestedGroupId;
    else log(`gruppo ${requestedGroupId} ignorato: non accessibile o nome senza prefisso ${GROUP_NAME_PREFIX}`);
  }

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
    throw new Error(scrub(e instanceof Error ? e.message : String(e)));
  }

  return async () => {
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
    if (disposable && JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`account dedicato: conteggi non tornati a quelli iniziali (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
    }
  };
}
