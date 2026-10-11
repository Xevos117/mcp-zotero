import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, createCollection, createItems, title, FAKE_KEY } from "./helpers/live.js";

describe.skipIf(!live.enabled)("get_collection_items (live)", () => {
  let s: LiveServer;
  let empty: string;
  let withAttachment: string;
  let exact: string;
  let exactItems: string[];
  beforeAll(async () => {
    s = await startLive();
    empty = await createCollection("empty");
    exact = await createCollection("exact");
    exactItems = await createItems([
      { itemType: "book", title: title("GCI one"), collections: [exact] },
      { itemType: "journalArticle", title: title("GCI two"), collections: [exact] },
      { itemType: "report", title: title("GCI three"), collections: [exact] },
    ]);
    withAttachment = await createCollection("with attachment");
    await createItems([
      { itemType: "book", title: title("Book next to attachment"), collections: [withAttachment] },
      { itemType: "attachment", linkMode: "linked_url", title: title("Standalone link"), url: "https://example.org/mzt-standalone", collections: [withAttachment] },
    ]);
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-GCI-01 collezione con 3 voci note → esattamente quelle; la collezione della run contiene le fixture ma non la voce della sottocollezione", async () => {
    const r = await s.call("get_collection_items", { collectionKey: exact });
    expect(r.isError).toBe(false);
    expect(r.json.total_items).toBe(3);
    expect(r.json.items.map((i: { key: string }) => i.key).sort()).toEqual([...exactItems].sort());
    // altri file aggiungono voci alla collezione della run: qui si controlla solo l'inclusione
    const run = await s.call("get_collection_items", { collectionKey: live.collection });
    const keys = new Set(run.json.items.map((i: { key: string }) => i.key));
    const f = live.fixtures;
    for (const k of [f.article, f.book, f.many, f.noAuthor, f.webpage]) expect(keys.has(k), k).toBe(true);
    expect(keys.has(f.inSub)).toBe(false);
  });

  it("LIVE-GCI-02 sottocollezione → la sua voce", async () => {
    const r = await s.call("get_collection_items", { collectionKey: live.subcollection });
    expect(r.json.items.map((i: { key: string }) => i.key)).toEqual([live.fixtures.inSub]);
  });

  it("LIVE-GCI-03 105 voci → paginazione oltre 100, nessuna voce persa o duplicata", async () => {
    const r = await s.call("get_collection_items", { collectionKey: live.bulkCollection });
    expect(r.json.total_items).toBe(live.bulk.length);
    expect(r.json.returned_items).toBe(live.bulk.length);
    const keys = r.json.items.map((i: { key: string }) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...live.bulk].sort());
  });

  it("LIVE-GCI-04 allegato standalone: escluso di default, incluso con excludeAttachments false", async () => {
    const def = await s.call("get_collection_items", { collectionKey: withAttachment });
    expect(def.json.items.map((i: { itemType: string }) => i.itemType)).toEqual(["book"]);
    const all = await s.call("get_collection_items", { collectionKey: withAttachment, excludeAttachments: false });
    expect(all.json.items.map((i: { itemType: string }) => i.itemType).sort()).toEqual(["attachment", "book"]);
  });

  it("LIVE-GCI-05 collezione vuota → messaggio senza isError", async () => {
    const r = await s.call("get_collection_items", { collectionKey: empty });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ message: "Collection is empty", status: "empty" });
  });

  it("LIVE-GCI-06 collezione inesistente → isError; collectionKey mancante → errore di validazione", async () => {
    expect((await s.call("get_collection_items", { collectionKey: FAKE_KEY })).isError).toBe(true);
    expect((await s.call("get_collection_items", {})).text).toMatch(/collectionKey/);
  });

  it("LIVE-GCI-07 override library_type user → stesso risultato", async () => {
    const r = await s.call("get_collection_items", { collectionKey: live.subcollection, library_type: "user" });
    expect(r.json.items.map((i: { key: string }) => i.key)).toEqual([live.fixtures.inSub]);
  });
});
