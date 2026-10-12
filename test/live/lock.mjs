#!/usr/bin/env node
// Serializes access to the Zotero test library across runs (live suite, agent smoke, different PRs,
// worktrees or machines): a collection named "mzt-lock <runId>" is the lock. The lock created first wins,
// ordered by the collection's Zotero `version` (the library version of the write that created it, strictly
// increasing per library; lock collections are never modified). Ordering by runId instead let two runs both
// win: a run whose runId was older but whose lock was created a moment later saw the other lock as newer.
// Others poll with backoff up to the wait bound, then fail with "test account busy". Locks older than the
// expiry belong to dead runs and are removed. runId = "<timestamp base36>-<4 hex>", so a lock's age comes
// from its name.
//   node test/live/lock.mjs acquire <runId>    (env ZOTERO_TEST_API_KEY, optional ZOTERO_LIVE_LOCK_WAIT_MIN)
//   node test/live/lock.mjs release <runId>
import { fileURLToPath } from "node:url";

export const LOCK_PREFIX = "mzt-lock ";
/**
 * Age of the runId (taken before waiting) after which a lock belongs to a dead run: longer than the CI wait (70 min)
 * plus the longest holder (agent smoke: about 80 min from the lock to the release).
 */
export const LOCK_STALE_MS = 180 * 60 * 1000;
export const DEFAULT_LOCK_WAIT_MS = 25 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const RUN_ID_RE = /^([0-9a-z]{8,9})-([0-9a-f]{4})$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const runIdTime = (runId) => {
  const m = RUN_ID_RE.exec(runId);
  return m ? parseInt(m[1], 36) : NaN;
};

async function api(key, method, path, body, extraHeaders = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.zotero.org/${path}`, {
        method,
        headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3", ...(body ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt >= 5) throw new Error(`${method} ${path.split("?")[0]}: ${e.message}`);
      await sleep(1000 * attempt);
      continue;
    }
    if ([429, 502, 503, 504].includes(res.status) && attempt < 5) {
      await sleep(Math.min(Number(res.headers.get("retry-after") ?? attempt * 2), 60) * 1000);
      continue;
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, data: text ? safeJson(text) : undefined };
  }
}
const safeJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

async function listLocks(key, lib) {
  const out = [];
  for (let start = 0; ; start += 100) {
    const r = await api(key, "GET", `${lib}/collections?limit=100&start=${start}`);
    if (r.status !== 200) throw new Error(`list collections: HTTP ${r.status}`);
    out.push(...r.data);
    if (r.data.length < 100) break;
  }
  return out
    .filter((c) => String(c.data.name).startsWith(LOCK_PREFIX))
    .map((c) => ({ key: c.key, version: Number(c.version ?? c.data.version), runId: String(c.data.name).slice(LOCK_PREFIX.length) }))
    .filter((l) => Number.isFinite(runIdTime(l.runId)));
}

async function deleteCollections(key, lib, keys) {
  for (let attempt = 1; ; attempt++) {
    const v = await api(key, "GET", `${lib}/collections?limit=1&format=keys`);
    const version = v.headers.get("last-modified-version");
    const r = await api(key, "DELETE", `${lib}/collections?collectionKey=${keys.join(",")}`, undefined, { "If-Unmodified-Since-Version": version });
    if (r.status === 204) return;
    if (r.status === 412 && attempt < 8) {
      await sleep(250 * attempt + Math.floor(Math.random() * 500)); // library changed meanwhile
      continue;
    }
    throw new Error(`delete lock: HTTP ${r.status}`);
  }
}

async function libraryPath(key) {
  const r = await api(key, "GET", "keys/current");
  if (r.status !== 200) throw new Error(`keys/current: HTTP ${r.status}`);
  return `users/${r.data.userID}`;
}

/** Takes the lock for runId, waiting for older live runs. Returns the lock collection key. */
export async function acquireLock({ key, lib, runId, waitMs = DEFAULT_LOCK_WAIT_MS, log = console.log }) {
  if (!Number.isFinite(runIdTime(runId))) throw new Error(`invalid runId ${runId}`);
  lib ??= await libraryPath(key);
  const created = await api(key, "POST", `${lib}/collections`, [{ name: `${LOCK_PREFIX}${runId}` }]);
  const lockKey = created.data?.successful?.["0"]?.key;
  if (!lockKey) throw new Error(`create lock: HTTP ${created.status}`);
  // the creation version orders the locks; read it back from the listing if the write response lacks it
  let lockVersion = Number(created.data.successful["0"].version);
  const deadline = Date.now() + waitMs;
  for (let round = 0; ; round++) {
    const locks = await listLocks(key, lib);
    if (!Number.isFinite(lockVersion)) lockVersion = locks.find((l) => l.key === lockKey)?.version;
    if (!Number.isFinite(lockVersion)) throw new Error("lock collection without a version");
    const others = locks.filter((l) => l.key !== lockKey);
    const stale = others.filter((o) => Date.now() - runIdTime(o.runId) > LOCK_STALE_MS);
    if (stale.length) {
      log(`[lock] removing expired lock(s) of run(s) ${stale.map((s) => s.runId).join(", ")}`);
      await deleteCollections(key, lib, stale.map((s) => s.key));
    }
    const older = others.filter((o) => !stale.includes(o) && (!Number.isFinite(o.version) || o.version < lockVersion));
    if (older.length === 0) {
      log(`[lock] acquired ${runId}`);
      return lockKey;
    }
    if (Date.now() > deadline) {
      await deleteCollections(key, lib, [lockKey]);
      throw new Error(`test account busy: run ${older.map((o) => o.runId).join(", ")} holds the Zotero test library lock; gave up after ${waitMs >= 60_000 ? `${Math.round(waitMs / 60000)} min` : `${Math.round(waitMs / 1000)} s`}`);
    }
    const pause = Math.min(15_000 * 2 ** Math.min(round, 2), 60_000); // 15 s, 30 s, then every 60 s
    log(`[lock] waiting for run ${older[0].runId} (next check in ${pause / 1000} s)`);
    await sleep(Math.min(pause, Math.max(1_000, deadline - Date.now() + 1_000)));
  }
}

/** Removes every lock collection of runId (idempotent). */
export async function releaseLock({ key, lib, runId, log = console.log }) {
  lib ??= await libraryPath(key);
  const mine = (await listLocks(key, lib)).filter((l) => l.runId === runId);
  if (mine.length) await deleteCollections(key, lib, mine.map((l) => l.key));
  log(`[lock] released ${runId} (${mine.length} lock collection(s) removed)`);
  return mine.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, runId] = process.argv.slice(2);
  const key = process.env.ZOTERO_TEST_API_KEY ?? "";
  const scrub = (t) => (key ? String(t).split(key).join("***") : String(t));
  if (!key || !["acquire", "release"].includes(cmd) || !runId) {
    console.error("usage: ZOTERO_TEST_API_KEY=... node test/live/lock.mjs acquire|release <runId>");
    process.exit(2);
  }
  const waitMs = Number(process.env.ZOTERO_LIVE_LOCK_WAIT_MIN ?? DEFAULT_LOCK_WAIT_MS / 60000) * 60000;
  const run = cmd === "acquire" ? acquireLock({ key, runId, waitMs }) : releaseLock({ key, runId });
  run.then(
    () => {},
    (e) => {
      console.error(`[lock] ${scrub(e instanceof Error ? e.message : e)}`);
      process.exit(1);
    }
  );
}
