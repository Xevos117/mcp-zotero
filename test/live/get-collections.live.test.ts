import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, title } from "./helpers/live.js";

describe.skipIf(!live.enabled)("get_collections (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-GC-01 collezione e sottocollezione della run presenti, con nome e genitore", async () => {
    const r = await s.call("get_collections", {});
    expect(r.isError).toBe(false);
    const byKey = new Map(r.json.map((c: Record<string, unknown>) => [c.key, c]));
    expect(byKey.get(live.collection)).toMatchObject({ name: live.prefix });
    expect(byKey.get(live.subcollection)).toMatchObject({ name: title("sub"), parentCollection: live.collection });
    expect(r.json.some((c: { deleted?: boolean }) => c.deleted)).toBe(false);
  });

  it("LIVE-GC-02 include_trashed → almeno le stesse collezioni", async () => {
    const plain = await s.call("get_collections", {});
    const all = await s.call("get_collections", { include_trashed: true });
    expect(all.json.length).toBeGreaterThanOrEqual(plain.json.length);
    expect(all.json.some((c: { key: string }) => c.key === live.collection)).toBe(true);
  });

  it("LIVE-GC-03 override library_id = proprio id; include_trashed di tipo sbagliato → errore", async () => {
    const own = await s.call("get_collections", { library_id: live.userId });
    expect(own.json.some((c: { key: string }) => c.key === live.collection)).toBe(true);
    expect((await s.call("get_collections", { include_trashed: "yes" })).text).toMatch(/include_trashed/);
  });
});
