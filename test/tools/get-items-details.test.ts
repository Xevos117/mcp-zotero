import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectToolError,
  expectApiError,
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
        article("AAAARRRR", { volume: "12", pages: "1-10" }),
        {
          key: "BBBB2222",
          itemType: "bookSection",
          title: "Chapter",
          bookTitle: "The Book",
          creators: [{ creatorType: "editor", name: "ACM" }],
        },
      ])
    );
    const out = await h.call("get_items_details", { item_keys: ["AAAARRRR", "BBBB2222"] });
    expect(out.isError).toBe(false);
    expect(Object.keys(out.json).sort()).toEqual(["AAAARRRR", "BBBB2222"]);
    expect(out.json.AAAARRRR).toMatchObject({
      itemType: "journalArticle",
      title: "Article AAAARRRR",
      authors: "Ada Lovelace",
      DOI: "10.1000/aaaarrrr",
      volume: "12",
      pages: "1-10",
    });
    expect(out.json.BBBB2222).toMatchObject({ itemType: "bookSection", bookTitle: "The Book" });
    expect(h.net.calls).toHaveLength(1);
    expect(h.net.calls[0].url.searchParams.get("itemKey")).toBe("AAAARRRR,BBBB2222");
  });

  it("GID-02 abstract escluso di default, incluso con include_abstract=true", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR", { abstractNote: "Abstract text" })]));
    const def = await h.call("get_items_details", { item_keys: ["AAAARRRR"] });
    expect(def.json.AAAARRRR).not.toHaveProperty("abstractNote");
    const inc = await h.call("get_items_details", { item_keys: ["AAAARRRR"], include_abstract: true });
    expect(inc.json.AAAARRRR.abstractNote).toBe("Abstract text");
  });

  it("GID-03 campi strutturali e valori vuoti/false/null esclusi", async () => {
    h.net.on(
      "GET",
      ITEMS,
      zLibraryQuery([
        article("AAAARRRR", { extra: "", series: null, archive: false, dateModified: "x", tags: [{ tag: "t" }] }),
      ])
    );
    const out = await h.call("get_items_details", { item_keys: ["AAAARRRR"] });
    const entry = out.json.AAAARRRR;
    for (const f of ["key", "dateAdded", "dateModified", "collections", "tags", "relations", "extra", "series", "archive"]) {
      expect(entry).not.toHaveProperty(f);
    }
    // version is exposed (update_item needs it); it is a number, not a bibliographic field
    expect(entry.version).toBe(1);
  });

  it("GID-15 creators strutturati accanto ad authors (cognomi multiparola, nome istituzionale)", async () => {
    const creators = [
      { creatorType: "author", firstName: "Hans", lastName: "de Kroon" },
      { creatorType: "author", firstName: "Paulo", lastName: "Caetano da Silva" },
      { creatorType: "editor", name: "Test Consortium" },
    ];
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR", { creators }), article("NPCREATR", { creators: [] })]));
    const out = await h.call("get_items_details", { item_keys: ["AAAARRRR", "NPCREATR"] });
    expect(out.json.AAAARRRR.creators).toEqual(creators);
    expect(out.json.AAAARRRR.authors).toBe("Hans de Kroon, Paulo Caetano da Silva, Test Consortium");
    expect(out.json.NPCREATR).not.toHaveProperty("creators");
  });

  it("GID-16 chiavi malformate → errore di validazione senza richieste; risposta con voci in più → solo quelle richieste", async () => {
    expectValidationError(await h.call("get_items_details", { item_keys: ["zzzzzzzz", "ZZZZZZZ0"] }), "item_keys");
    expect(h.net.calls).toHaveLength(0);
    // API che ignora il filtro e restituisce la libreria intera
    h.net.on("GET", ITEMS, (req, hit) => {
      const u = new URL(req.url.href);
      u.searchParams.delete("itemKey");
      return zLibraryQuery([article("BBBB2222"), article("AAAARRRR")])({ ...req, url: u }, hit);
    });
    const out = await h.call("get_items_details", { item_keys: ["BBBB2222", "CCCC3333"] });
    expect(Object.keys(out.json)).toEqual(["BBBB2222", "not_found"]);
    expect(out.json.not_found).toEqual(["CCCC3333"]);
  });

  it("GID-04 array vuoto → errore di validazione dello schema (come delete_items/add_items), nessuna rete", async () => {
    expectValidationError(await h.call("get_items_details", { item_keys: [] }), "item_keys");
    expect(h.net.calls).toHaveLength(0);
  });

  it("GID-05 nessun item trovato → risultato vuoto con le chiavi richieste", async () => {
    h.net.on("GET", ITEMS, zList([]));
    const json = expectEmptyResult(await h.call("get_items_details", { item_keys: ["NPPEQQQR"] }), "No items found");
    expect(json.item_keys).toEqual(["NPPEQQQR"]);
    expect(json.suggestion).toMatch(/None of these keys exists.*search_library/);
  });

  it("GID-06 chiavi parzialmente inesistenti: voci trovate più not_found con le mancanti, senza isError", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
    const out = await h.call("get_items_details", { item_keys: ["AAAARRRR", "NPPEQQQR", "NPPEQQQR", "NPPEQQQS"] });
    expect(out.isError).toBe(false);
    expect(Object.keys(out.json)).toEqual(["AAAARRRR", "not_found"]);
    expect(out.json.not_found).toEqual(["NPPEQQQR", "NPPEQQQS"]);
    expect(out.json.AAAARRRR.title).toBeDefined();
  });

  it("GID-17 tutte le chiavi trovate → nessun campo not_found", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR"), article("BBBB2222")]));
    const out = await h.call("get_items_details", { item_keys: ["AAAARRRR", "BBBB2222"] });
    expect(out.json).not.toHaveProperty("not_found");
  });

  it("GID-07 fallback per item senza tipo/titolo", async () => {
    h.net.on("GET", ITEMS, zList([{ key: "MINQQQQR" }]));
    const out = await h.call("get_items_details", { item_keys: ["MINQQQQR"] });
    expect(out.json.MINQQQQR).toEqual({ itemType: "document", title: "Untitled", authors: "No authors listed", version: 1 });
  });

  it("GID-08 unicode preservato", async () => {
    h.net.on("GET", ITEMS, zLibraryQuery([article("UNIQQQQR", { title: "Über 学习 🚀", publicationTitle: "Revue française" })]));
    const out = await h.call("get_items_details", { item_keys: ["UNIQQQQR"] });
    expect(out.json.UNIQQQQR.title).toBe("Über 学习 🚀");
    expect(out.json.UNIQQQQR.publicationTitle).toBe("Revue française");
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
      ["item_keys", { item_keys: "AAAARRRR" }],
      ["item_keys", { item_keys: [1, 2] }],
      ["include_abstract", { item_keys: ["A"], include_abstract: "true" }],
    ])("GID-12 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("get_items_details", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  it.each(ZOTERO_ERROR_STATUSES)("GID-13 HTTP %i → isError", async (status) => {
    h.net.on("GET", ITEMS, zError(status));
    expectApiError(await h.call("get_items_details", { item_keys: ["AAAARRRR"] }), status);
  });

  it("GID-14 errore di rete → isError", async () => {
    h.net.on("GET", ITEMS, networkError());
    expectApiError(await h.call("get_items_details", { item_keys: ["AAAARRRR"] }));
  });
});
