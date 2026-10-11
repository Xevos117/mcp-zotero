import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, title, web } from "./helpers/live.js";
import { poll } from "./helpers/zotero-web.js";

describe.skipIf(!live.enabled)("search_library (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-SL-01 query sul titolo di una fixture → solo quella voce, con autori e data", async () => {
    const r = await poll(() => s.call("search_library", { query: title("Many authors paper") }), (x) => Array.isArray(x.json) && x.json.length > 0);
    expect(r.isError).toBe(false);
    expect(r.json.map((i: { key: string }) => i.key)).toEqual([live.fixtures.many]);
    expect(r.json[0]).toMatchObject({ title: title("Many authors paper"), date: "2020-06-25", itemType: "journalArticle" });
    expect(r.json[0].authors).toContain("Pessoa");
  });

  it("LIVE-SL-02 query sul prefisso della run, sort title asc, limit 3 → le prime 3 voci della run in ordine", async () => {
    const r = await poll(() => s.call("search_library", { query: live.prefix, sort: "title", direction: "asc", limit: 3 }), (x) => x.json?.length === 3);
    const titles: string[] = r.json.map((i: { title: string }) => i.title);
    expect(titles.every((t) => t.startsWith(live.prefix))).toBe(true);
    expect([...titles].sort((a, b) => a.localeCompare(b))).toEqual(titles);
  });

  it("LIVE-SL-03 senza query: limit 5 per ogni sort/direction → 5 voci", async () => {
    for (const sort of ["dateAdded", "dateModified", "title", "creator", "date"]) {
      for (const direction of ["asc", "desc"]) {
        const r = await s.call("search_library", { sort, direction, limit: 5 });
        expect(r.isError, `${sort} ${direction}`).toBe(false);
        expect(r.json.length, `${sort} ${direction}`).toBe(5);
      }
    }
  });

  it("LIVE-SL-04 limit 500 → al massimo 100 (limite dell'API)", async () => {
    const total = await web().totalResults("items");
    const r = await s.call("search_library", { limit: 500 });
    expect(r.json.length).toBe(Math.min(100, total));
  });

  it("LIVE-SL-05 dateAdded desc → ordine decrescente, la prima voce non è più vecchia delle fixture della run", async () => {
    const r = await s.call("search_library", { sort: "dateAdded", direction: "desc", limit: 50 });
    const dates: string[] = r.json.map((i: { dateAdded: string }) => i.dateAdded);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}T/.test(d))).toBe(true);
    expect([...dates].sort().reverse()).toEqual(dates);
    const fixture = (await web().getOk(`items/${live.fixtures.article}`)).data.data.dateAdded;
    expect(dates[0] >= fixture).toBe(true);
  });

  it("LIVE-SL-06 nessun risultato → messaggio, senza isError", async () => {
    const r = await s.call("search_library", { query: `${live.prefix}-nothing-matches-this` });
    expect(r.isError).toBe(false);
    expect(r.json.message).toBe("No results found");
  });

  it("LIVE-SL-07 argomenti non validi → isError col nome del campo", async () => {
    expect((await s.call("search_library", { sort: "bogus" })).text).toMatch(/sort/);
    expect((await s.call("search_library", { limit: "ten" })).text).toMatch(/limit/);
  });

  it("LIVE-SL-08 override libreria: library_id = proprio id → stessi risultati; gruppo senza id → errore; gruppo inesistente → isError", async () => {
    const own = await s.call("search_library", { query: title("Many authors paper"), library_type: "user", library_id: live.userId });
    expect(own.json.map((i: { key: string }) => i.key)).toEqual([live.fixtures.many]);
    const noId = await s.call("search_library", { library_type: "group" });
    expect(noId.isError).toBe(true);
    expect(noId.text).toMatch(/library_id/);
    const ghost = await s.call("search_library", { library_type: "group", library_id: "999999999", limit: 1 });
    expect(ghost.isError).toBe(true);
    expect(ghost.text).toMatch(/40[34]/);
  });
});
