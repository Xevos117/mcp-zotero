import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, title, FAKE_KEY, FAKE_KEY_2 } from "./helpers/live.js";

describe.skipIf(!live.enabled)("get_items_details (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  it("LIVE-GID-01 fixture → campi per tipo, creators strutturati, abstract escluso di default", async () => {
    const f = live.fixtures;
    const r = await s.call("get_items_details", { item_keys: [f.article, f.book, f.noAuthor] });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.json).sort()).toEqual([f.article, f.book, f.noAuthor].sort());
    expect(r.json[f.article]).toMatchObject({
      itemType: "journalArticle",
      title: title("Article on live testing"),
      publicationTitle: "Journal of Live Tests",
      volume: "3",
      issue: "2",
      pages: "1-10",
      date: "2024-05-01",
      DOI: "10.9999/mzt.fixture",
      url: "https://example.org/mzt-article",
      creators: [
        { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
        { creatorType: "author", firstName: "Alan", lastName: "Turing" },
      ],
    });
    expect(r.json[f.article].authors).toMatch(/Lovelace.*Turing/);
    expect(r.json[f.article]).not.toHaveProperty("abstractNote");
    expect(r.json[f.book]).toMatchObject({ publisher: "Test Press", place: "Rome", creators: [{ creatorType: "author", name: "Test Consortium" }] });
    expect(r.json[f.book].authors).toBe("Test Consortium");
    expect(r.json[f.noAuthor]).not.toHaveProperty("creators");
  });

  it("LIVE-GID-02 include_abstract → abstractNote presente", async () => {
    const r = await s.call("get_items_details", { item_keys: [live.fixtures.article], include_abstract: true });
    expect(r.json[live.fixtures.article].abstractNote).toBe("Fixture abstract for the live suite.");
  });

  it("LIVE-GID-03 105 chiavi → tutte restituite (blocchi da 50, oltre la pagina massima di 100)", async () => {
    const r = await s.call("get_items_details", { item_keys: live.bulk });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.json).sort()).toEqual([...live.bulk].sort());
  });

  it("LIVE-GID-04 solo chiavi sconosciute → risultato vuoto senza isError; miste → solo le note", async () => {
    const none = await s.call("get_items_details", { item_keys: [FAKE_KEY, FAKE_KEY_2] });
    expect(none.isError).toBe(false);
    expect(none.json.message).toBe("No items found for the given keys");
    const mixed = await s.call("get_items_details", { item_keys: [live.fixtures.book, FAKE_KEY] });
    expect(Object.keys(mixed.json)).toEqual([live.fixtures.book]);
  });

  it("LIVE-GID-05 override library_id = proprio id; item_keys vuoto → isError", async () => {
    const own = await s.call("get_items_details", { item_keys: [live.fixtures.book], library_id: live.userId });
    expect(Object.keys(own.json)).toEqual([live.fixtures.book]);
    expect((await s.call("get_items_details", { item_keys: [] })).isError).toBe(true);
  });
});
