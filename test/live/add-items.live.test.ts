import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { live, startLive, LiveServer, title, trackItems, rawItem } from "./helpers/live.js";

describe.skipIf(!live.enabled)("add_items (live)", () => {
  let s: LiveServer;
  beforeAll(async () => {
    s = await startLive();
  });
  afterAll(async () => {
    await s?.close();
  });

  const keysOf = (r: { json: any }) => (r.json?.success ?? []).map((x: { item_key: string }) => x.item_key);

  it("LIVE-AI-01 8 tipi con collection_key e tag → creati nell'ordine, campi per tipo salvati", async () => {
    const items = [
      { itemType: "journalArticle", title: title("AI article"), creators: [{ firstName: "Ada", lastName: "Lovelace" }], publicationTitle: "J. Tests", volume: "3", pages: "1-10", date: "2024", DOI: "10.9999/mzt.ai", abstractNote: "Abstract text" },
      { itemType: "book", title: title("AI book"), creators: [{ name: "Test Consortium" }], publisher: "Test Press", place: "Rome", ISBN: "9780000000002" },
      { itemType: "bookSection", title: title("AI chapter"), bookTitle: "MZT edited volume", creators: [{ firstName: "Grace", lastName: "Hopper" }, { firstName: "Ed", lastName: "Itor", creatorType: "editor" }] },
      { itemType: "thesis", title: title("AI thesis"), university: "Test University", thesisType: "PhD" },
      { itemType: "report", title: title("AI report"), institution: "Test Institute", reportNumber: "TR-1" },
      { itemType: "conferencePaper", title: title("AI conference paper"), proceedingsTitle: "Proc. Tests" },
      { itemType: "webpage", title: title("AI webpage"), url: "https://example.org/mzt-ai", websiteTitle: "Example" },
      { itemType: "film", title: title("AI film"), creators: [{ firstName: "Dee", lastName: "Rector", creatorType: "director" }] },
    ];
    const r = await s.call("add_items", { items, collection_key: live.collection, tags: [live.runTag, "mzt-ai"] });
    trackItems(...keysOf(r));
    expect(r.isError).toBe(false);
    expect(r.json.failed).toBeUndefined();
    expect(r.json.success.map((x: { title: string }) => x.title)).toEqual(items.map((i) => i.title));
    const [article, book, chapter, thesis] = await Promise.all(keysOf(r).slice(0, 4).map((k: string) => rawItem(k)));
    expect(article).toMatchObject({ publicationTitle: "J. Tests", DOI: "10.9999/mzt.ai", abstractNote: "Abstract text", collections: [live.collection] });
    expect(article!.tags.map((t: { tag: string }) => t.tag).sort()).toEqual([live.runTag, "mzt-ai"].sort());
    expect(book!.creators).toEqual([{ creatorType: "author", name: "Test Consortium" }]);
    expect(chapter).toMatchObject({ bookTitle: "MZT edited volume" });
    expect(chapter!.creators[1]).toMatchObject({ creatorType: "editor", lastName: "Itor" });
    expect(thesis).toMatchObject({ university: "Test University", thesisType: "PhD" });
  });

  it("LIVE-AI-02 55 voci → due POST, risultati associati per indice, chiavi distinte", async () => {
    const items = Array.from({ length: 55 }, (_, i) => ({ itemType: "book", title: title(`AI batch ${String(i).padStart(2, "0")}`) }));
    const r = await s.call("add_items", { items, tags: [live.runTag] });
    trackItems(...keysOf(r));
    expect(r.json.success).toHaveLength(55);
    for (const x of r.json.success) expect(x.title).toBe(title(`AI batch ${String(x.index).padStart(2, "0")}`));
    expect(new Set(keysOf(r)).size).toBe(55);
    expect((await rawItem(r.json.success[54].item_key))!.title).toBe(r.json.success[54].title);
  });

  it.each([
    ["itemType non valido", [{ itemType: "spaceship", title: "x" }], /itemType/],
    ["campo non valido per il tipo", [{ itemType: "book", title: "x", publicationTitle: "Nature" }], /publicationTitle/],
    ["creatorType non valido per il tipo", [{ itemType: "book", title: "x", creators: [{ name: "n", creatorType: "director" }] }], /creatorType/],
    ["items vuoto", [], /items/],
  ])("LIVE-AI-03 %s → errore prima di scrivere", async (_label, items, message) => {
    const r = await s.call("add_items", { items, tags: [live.runTag] });
    trackItems(...keysOf(r));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
  });

  it("LIVE-AI-04 collection_key inesistente → fallimento leggibile", async () => {
    const r = await s.call("add_items", { items: [{ itemType: "book", title: title("AI bad collection") }], collection_key: "ZZZZZZZZ", tags: [live.runTag] });
    trackItems(...keysOf(r));
    expect(r.isError || r.json?.failed?.length === 1).toBe(true);
    expect(r.text).not.toMatch(/\[object Object\]/);
  });
});
