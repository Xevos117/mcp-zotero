import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { acquireLock, releaseLock } from "../../test/live/lock.mjs";

/**
 * Lock della libreria di test (test/live/lock.mjs) con l'API Zotero finta in memoria: le righe
 * "[lock] acquired/released <runId>" compaiono nei log, così chi controlla i log CI vede quando la run
 * ha tenuto l'account.
 */
function fakeZotero({ versionInWriteResponse = true } = {}) {
  // `version` = library version of the write that created the collection, as in the Zotero Web API
  const collections: Array<{ key: string; version: number; data: { name: string } }> = [];
  let n = 0;
  let libraryVersion = 100;
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Last-Modified-Version": "1" } });
    if (init.method === "POST") {
      const [c] = JSON.parse(String(init.body));
      const key = `LOCK${String(n++).padStart(4, "2")}`;
      const version = ++libraryVersion;
      collections.push({ key, version, data: { name: c.name } });
      return json({ successful: { "0": versionInWriteResponse ? { key, version } : { key } } });
    }
    if (init.method === "DELETE") {
      const keys = (u.searchParams.get("collectionKey") ?? "").split(",");
      for (const k of keys) collections.splice(collections.findIndex((c) => c.key === k), 1);
      libraryVersion++;
      return new Response(null, { status: 204 });
    }
    if (u.searchParams.get("format") === "keys") return new Response(collections.map((c) => c.key).join("\n"), { headers: { "Last-Modified-Version": "1" } });
    return json(collections);
  });
}

describe("lock dell'account di test (LK)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("LK-01 acquire senza altre run e release → righe [lock] acquired / released con il runId", async () => {
    vi.stubGlobal("fetch", fakeZotero());
    const log = vi.fn();
    const runId = `${Date.now().toString(36)}-ab12`;
    await acquireLock({ key: "k", lib: "users/1", runId, waitMs: 1000, log });
    expect(log).toHaveBeenCalledWith(`[lock] acquired ${runId}`);
    expect(await releaseLock({ key: "k", lib: "users/1", runId, log })).toBe(1);
    expect(log).toHaveBeenCalledWith(`[lock] released ${runId} (1 lock collection(s) removed)`);
  });

  it("LK-02 corsa: il lock creato prima vince anche se il suo runId è più recente; l'altro aspetta", async () => {
    vi.stubGlobal("fetch", fakeZotero());
    const log = vi.fn();
    const now = Date.now();
    const olderRunId = `${(now - 30_000).toString(36)}-0001`; // generato prima (es. all'avvio di prepare)
    const newerRunId = `${now.toString(36)}-0002`;
    // la run con il runId più recente crea il lock per prima e lo prende
    await acquireLock({ key: "k", lib: "users/1", runId: newerRunId, waitMs: 1000, log });
    expect(log).toHaveBeenCalledWith(`[lock] acquired ${newerRunId}`);
    // la run con il runId più vecchio arriva dopo: deve aspettare, non prendere anche lei il lock
    await expect(acquireLock({ key: "k", lib: "users/1", runId: olderRunId, waitMs: 0, log })).rejects.toThrow(`test account busy: run ${newerRunId}`);
    expect(log).not.toHaveBeenCalledWith(`[lock] acquired ${olderRunId}`);
    // il suo lock è stato rimosso; quello della prima run resta
    expect(await releaseLock({ key: "k", lib: "users/1", runId: olderRunId, log })).toBe(0);
    expect(await releaseLock({ key: "k", lib: "users/1", runId: newerRunId, log })).toBe(1);
  });

  it("LK-03 versione assente nella risposta di creazione → letta dall'elenco, stesso ordine", async () => {
    vi.stubGlobal("fetch", fakeZotero({ versionInWriteResponse: false }));
    const log = vi.fn();
    const now = Date.now();
    const first = `${now.toString(36)}-0003`;
    const second = `${(now - 1000).toString(36)}-0004`;
    await acquireLock({ key: "k", lib: "users/1", runId: first, waitMs: 1000, log });
    await expect(acquireLock({ key: "k", lib: "users/1", runId: second, waitMs: 0, log })).rejects.toThrow("test account busy");
  });
});
