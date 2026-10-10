import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
  ZOTERO_ERROR_STATUSES,
  expectEmptyResult,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zList, zError, zLibraryQuery, article, manyArticles } from "../helpers/zotero-fake.js";

const ITEMS = `${ZBASE}/items`;

describe("get_items_details (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GID-01 mappa chiave → metadati con un'unica GET itemKey=A,B", async () => {
    h.net.on(
      "GET",
      ITEMS,
      zLibraryQuery([
        article("AAAA1111", { volume: "12", pages: "1-10" }),
        {
          key: "BBBB2222",
          itemType: "bookSection",
          title: "Chapter",
          bookTitle: "The Book",
          creators: [{ creatorType: "editor", name: "ACM" }],
        },
      ])
    );
    const out = await h.call("get_items_details", { item_keys: ["AAAA1111", "BBBB2222"] });
    expect(out.isError).toBe(false);
    expect(Object.keys(out.json).sort()).toEqual(["AAAA1111", "BBBB2222"]);
    expect(out.json.AAAA1111).toMatchObject({
      itemType: "journalArticle",
      title: "Article AAAA1111",
      authors: "Ada Lovelace",
      DOI: "10.1000/aaaa1111",
      volume: "12",
      pages: "1-10",
    });
    expect(out.json.BBBB2222).toMatchObject({ itemType: "bookSection", bookTitle: "The Book" });
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0].url.searchParams.get("itemKey")).toBe("AAAA1111,BBBB2222");
  });

  it("GID-02 abstract escluso di default, incluso con include_abstract=true", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111", { abstractNote: "Abstract text" })]));
    const def = await h.call("get_items_details", { item_keys: ["AAAA1111"] });
    expect(def.json.AAAA1111).not.toHaveProperty("abstractNote");
    const inc = await h.call("get_items_details", { item_keys: ["AAAA1111"], include_abstract: true });
    expect(inc.json.AAAA1111.abstractNote).toBe("Abstract text");
  });

  it("GID-03 campi strutturali e valori vuoti/false/null esclusi", async () => {
    h.net.on(
      "GET",
      ITEMS,
      zLibraryQuery([
        article("AAAA1111", { extra: "", series: null, archive: false, dateModified: "x", tags: [{ tag: "t" }] }),
      ])
    );
    const out = await h.call("get_items_details", { item_keys: ["AAAA1111"] });
    const entry = out.json.AAAA1111;
    for (const f of ["key", "version", "dateAdded", "dateModified", "collections", "tags", "relations", "creators", "extra", "series", "archive"]) {
      expect(entry).not.toHaveProperty(f);
    }
  });

  it("GID-04 array vuoto → errore strutturato senza chiamate di rete", async () => {
    expectErrorJson(await h.call("get_items_details", { item_keys: [] }), "At least one item key is required");
    expect(h.net.calls).toHaveLength(0);
  });

  it("GID-05 nessun item trovato → risultato vuoto con le chiavi richieste", async () => {
    h.net.on("GET", ITEMS, zList([]));
    const json = expectEmptyResult(await h.call("get_items_details", { item_keys: ["NOPE0001"] }), "No items found");
    expect(json.item_keys).toEqual(["NOPE0001"]);
  });

  it("GID-06 chiavi parzialmente inesistenti: restituisce solo quelle trovate", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")]));
    const out = await h.call("get_items_details", { item_keys: ["AAAA1111", "NOPE0001"] });
    expect(Object.keys(out.json)).toEqual(["AAAA1111"]);
  });

  it("GID-07 fallback per item senza tipo/titolo", async () => {
    h.net.on("GET", ITEMS, zList([{ key: "MIN00001" }]));
    const out = await h.call("get_items_details", { item_keys: ["MIN00001"] });
    expect(out.json.MIN00001).toEqual({ itemType: "document", title: "Untitled", authors: "No authors listed" });
  });

  it("GID-08 unicode preservato", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("UNI00001", { title: "Über 学习 🚀", publicationTitle: "Revue française" })]));
    const out = await h.call("get_items_details", { item_keys: ["UNI00001"] });
    expect(out.json.UNI00001.title).toBe("Über 学习 🚀");
    expect(out.json.UNI00001.publicationTitle).toBe("Revue française");
  });

  // Ex bug di main: tutte le chiavi in un solo itemKey senza limit. Dal vivo l'API restituisce
  // al massimo 100 item per pagina (Total-Results = N), quindi oltre 100 chiavi gli item in più
  // andavano persi; ora blocchi da 50 con limit esplicito.
  it("GID-09 120 chiavi: tutte restituite, GET a blocchi da 50 con limit", async () => {
    const lib = manyArticles(120);
    h.net.on("GET", ITEMS, zLibraryQuery(lib));
    const out = await h.call("get_items_details", { item_keys: lib.map((i) => i.key) });
    expect(Object.keys(out.json)).toHaveLength(120);
    expect(h.net.requests("GET", ITEMS).map((r) => r.url.searchParams.get("limit"))).toEqual(["50", "50", "20"]);
  });

  // Ex bug di main: con centinaia di chiavi l'URL diventa enorme e l'API risponde 500
  // (osservato dal vivo con 482 chiavi).
  it("GID-10 482 chiavi: nessun HTTP 500 per URL troppo lungo, tutte restituite", async () => {
    const lib = manyArticles(482);
    h.net.on("GET", ITEMS, zLibraryQuery(lib));
    const out = await h.call("get_items_details", { item_keys: lib.map((i) => i.key) });
    expect(out.isError).toBe(false);
    expect(Object.keys(out.json)).toHaveLength(482);
  });

  it("GID-11 batch entro il limite di pagina (20 chiavi) → una sola GET, tutte restituite", async () => {
    const lib = manyArticles(20);
    h.net.on("GET", ITEMS, zLibraryQuery(lib));
    const out = await h.call("get_items_details", { item_keys: lib.map((i) => i.key) });
    expect(Object.keys(out.json)).toHaveLength(20);
    expect(h.net.calls).toHaveLength(1);
  });

  describe("validazione input", () => {
    it.each([
      ["item_keys", {}],
      ["item_keys", { item_keys: "AAAA1111" }],
      ["item_keys", { item_keys: [1, 2] }],
      ["include_abstract", { item_keys: ["A"], include_abstract: "true" }],
    ])("GID-12 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("get_items_details", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  it.each(ZOTERO_ERROR_STATUSES)("GID-13 HTTP %i → isError", async (status) => {
    h.net.on("GET", ITEMS, zError(status));
    expectToolError(await h.call("get_items_details", { item_keys: ["AAAA1111"] }), String(status));
  });

  it("GID-14 errore di rete → isError", async () => {
    h.net.on("GET", ITEMS, networkError());
    expectToolError(await h.call("get_items_details", { item_keys: ["AAAA1111"] }));
  });
});
