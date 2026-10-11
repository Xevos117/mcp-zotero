import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { acquireLock, releaseLock } from "../../test/live/lock.mjs";

/**
 * Lock della libreria di test (test/live/lock.mjs) con l'API Zotero finta in memoria: le righe
 * "[lock] acquired/released <runId>" compaiono nei log, così chi controlla i log CI vede quando la run
 * ha tenuto l'account.
 */
function fakeZotero() {
  const collections: Array<{ key: string; data: { name: string } }> = [];
  let n = 0;
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Last-Modified-Version": "1" } });
    if (init.method === "POST") {
      const [c] = JSON.parse(String(init.body));
      const key = `LOCK${String(n++).padStart(4, "2")}`;
      collections.push({ key, data: { name: c.name } });
      return json({ successful: { "0": { key } } });
    }
    if (init.method === "DELETE") {
      const keys = (u.searchParams.get("collectionKey") ?? "").split(",");
      for (const k of keys) collections.splice(collections.findIndex((c) => c.key === k), 1);
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
});
