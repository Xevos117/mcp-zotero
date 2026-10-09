import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
  expectEmptyResult,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import {
  ZBASE,
  zList,
  zError,
  zLibraryQuery,
  article,
  pdfAttachment,
  manyArticles,
} from "../helpers/zotero-fake.js";

const COLL_ITEMS = `${ZBASE}/collections/COL00001/items`;

describe("get_collection_items (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GCI-01 formatta gli item della collezione con tutti i campi", async () => {
    h.net.on(
      "GET",
      COLL_ITEMS,
      zList([
        article("AAAA1111", {
          tags: [{ tag: "nlp" }, { tag: "survey" }],
          url: "https://example.org/a",
          publicationTitle: "JMLR",
        }),
      ])
    );
    const out = await h.call("get_collection_items", { collectionKey: "COL00001" });
    expect(out.isError).toBe(false);
    expect(out.json).toEqual({
      total_items: 1,
      returned_items: 1,
      items: [
        {
          title: "Article AAAA1111",
          authors: "Ada Lovelace",
          date: "2023-05-01",
          key: "AAAA1111",
          itemType: "journalArticle",
          tags: ["nlp", "survey"],
          doi: "10.1000/aaaa1111",
          url: "https://example.org/a",
          publicationTitle: "JMLR",
        },
      ],
    });
    expect(h.net.calls[0].url.pathname).toBe("/users/424242/collections/COL00001/items");
  });

  it("GCI-02 esclude allegati e note di default; total_items riflette Total-Results", async () => {
    h.net.on(
      "GET",
      COLL_ITEMS,
      zList([article("AAAA1111"), pdfAttachment("ATT00001", "AAAA1111"), { key: "NOTE0001", itemType: "note", note: "<p>x</p>" }])
    );
    const out = await h.call("get_collection_items", { collectionKey: "COL00001" });
    expect(out.json.total_items).toBe(3);
    expect(out.json.returned_items).toBe(1);
    expect(out.json.items.map((i: { key: string }) => i.key)).toEqual(["AAAA1111"]);
  });

  it("GCI-03 excludeAttachments=false include allegati e note", async () => {
    h.net.on("GET", COLL_ITEMS, zList([article("AAAA1111"), pdfAttachment("ATT00001", "AAAA1111")]));
    const out = await h.call("get_collection_items", { collectionKey: "COL00001", excludeAttachments: false });
    expect(out.json.returned_items).toBe(2);
  });

  it("GCI-04 fallback per item minimali", async () => {
    h.net.on("GET", COLL_ITEMS, zList([{ key: "MIN00001", itemType: "book" }]));
    const out = await h.call("get_collection_items", { collectionKey: "COL00001" });
    expect(out.json.items[0]).toEqual({
      title: "Untitled",
      authors: "No authors listed",
      date: "No date",
      key: "MIN00001",
      itemType: "book",
      tags: [],
      doi: null,
      url: null,
      publicationTitle: null,
    });
  });

  it("GCI-05 collezione vuota → risultato vuoto status 'empty'", async () => {
    h.net.on("GET", COLL_ITEMS, zList([]));
    const json = expectEmptyResult(await h.call("get_collection_items", { collectionKey: "COL00001" }), "Collection is empty");
    expect(json.status).toBe("empty");
    expect(json.collectionKey).toBe("COL00001");
  });

  it("GCI-06 solo allegati → risultato vuoto status 'invalid_items'", async () => {
    h.net.on("GET", COLL_ITEMS, zList([pdfAttachment("ATT00001", "X")]));
    const json = expectEmptyResult(
      await h.call("get_collection_items", { collectionKey: "COL00001" }),
      "No valid items found in collection"
    );
    expect(json.status).toBe("invalid_items");
  });

  it("GCI-07 paginazione: 230 item su 3 pagine", async () => {
    h.net.on("GET", COLL_ITEMS, zLibraryQuery(manyArticles(230)));
    const out = await h.call("get_collection_items", { collectionKey: "COL00001" });
    expect(out.json.total_items).toBe(230);
    expect(out.json.returned_items).toBe(230);
    expect(h.net.calls.map((c) => c.url.searchParams.get("start") ?? "0")).toEqual(["0", "100", "200"]);
  });

  it("GCI-08 404 → errore strutturato status 'not_found'", async () => {
    h.net.on("GET", COLL_ITEMS, zError(404, "Collection not found"));
    const json = expectErrorJson(
      await h.call("get_collection_items", { collectionKey: "COL00001" }),
      "Collection is empty or not accessible"
    );
    expect(json.status).toBe("not_found");
  });

  it.each([403, 412, 429, 500, 503])("GCI-09 HTTP %i → isError", async (status) => {
    h.net.on("GET", COLL_ITEMS, zError(status));
    expectToolError(await h.call("get_collection_items", { collectionKey: "COL00001" }), String(status));
  });

  it("GCI-10 errore di rete → isError", async () => {
    h.net.on("GET", COLL_ITEMS, networkError());
    expectToolError(await h.call("get_collection_items", { collectionKey: "COL00001" }));
  });

  it("GCI-11 unicode in titoli e tag", async () => {
    h.net.on("GET", COLL_ITEMS, zList([article("UNI00001", { title: "Ψυχολογία 心理学", tags: [{ tag: "ñ-tag" }] })]));
    const out = await h.call("get_collection_items", { collectionKey: "COL00001" });
    expect(out.json.items[0].title).toBe("Ψυχολογία 心理学");
    expect(out.json.items[0].tags).toEqual(["ñ-tag"]);
  });

  describe("validazione input", () => {
    it("GCI-12 collectionKey mancante", async () => {
      expectValidationError(await h.call("get_collection_items", {}), "collectionKey");
      expect(h.net.calls).toHaveLength(0);
    });
    it("GCI-13 collectionKey non stringa", async () => {
      expectValidationError(await h.call("get_collection_items", { collectionKey: 123 }), "collectionKey");
    });
    it("GCI-14 excludeAttachments non booleano", async () => {
      expectValidationError(
        await h.call("get_collection_items", { collectionKey: "COL00001", excludeAttachments: "no" }),
        "excludeAttachments"
      );
    });
  });
});
