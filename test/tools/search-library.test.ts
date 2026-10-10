import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectToolError,
  carriesApiKey,
  ZOTERO_ERROR_STATUSES,
  expectEmptyResult,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zList, zError, article } from "../helpers/zotero-fake.js";

const ITEMS = `${ZBASE}/items`;

describe("search_library (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("SL-01 query: GET /items con q, sort/direction/limit di default e lista formattata", async () => {
    h.net.on("GET", ITEMS, zList([article("AAAA1111"), article("BBBB2222", { title: "Second" })]));

    const out = await h.call("search_library", { query: "deep learning" });

    expect(out.isError).toBe(false);
    expect(out.json).toEqual([
      {
        title: "Article AAAA1111",
        authors: "Ada Lovelace",
        date: "2023-05-01",
        key: "AAAA1111",
        itemType: "journalArticle",
        dateAdded: "2024-01-01T00:00:00Z",
      },
      expect.objectContaining({ key: "BBBB2222", title: "Second" }),
    ]);
    const [req] = h.net.requests("GET", ITEMS);
    expect(req.url.searchParams.get("q")).toBe("deep learning");
    expect(req.url.searchParams.get("sort")).toBe("dateAdded");
    expect(req.url.searchParams.get("direction")).toBe("desc");
    expect(req.url.searchParams.get("limit")).toBe("25");
    expect(carriesApiKey(req.headers)).toBe(true);
    expect(h.net.calls).toHaveLength(1);
  });

  it("SL-02 senza query: elenco recenti, nessun parametro q", async () => {
    h.net.on("GET", ITEMS, zList([article("AAAA1111")]));
    const out = await h.call("search_library", {});
    expect(out.isError).toBe(false);
    expect(out.json).toHaveLength(1);
    expect(h.net.calls[0].url.searchParams.has("q")).toBe(false);
  });

  it("SL-03 query di soli spazi: nessun q inviato, query trimmata quando presente", async () => {
    h.net.on("GET", ITEMS, zList([article("AAAA1111")]));
    await h.call("search_library", { query: "   " });
    await h.call("search_library", { query: "  transformers  " });
    expect(h.net.calls[0].url.searchParams.has("q")).toBe(false);
    expect(h.net.calls[1].url.searchParams.get("q")).toBe("transformers");
  });

  it("SL-04 limit oltre 100 viene limitato a 100", async () => {
    h.net.on("GET", ITEMS, zList([article("AAAA1111")]));
    await h.call("search_library", { limit: 500 });
    expect(h.net.calls[0].url.searchParams.get("limit")).toBe("100");
  });

  it("SL-05 sort/direction personalizzati; dateAdded assente se sort != dateAdded", async () => {
    h.net.on("GET", ITEMS, zList([article("AAAA1111")]));
    const out = await h.call("search_library", { sort: "title", direction: "asc", limit: 5 });
    const p = h.net.calls[0].url.searchParams;
    expect(p.get("sort")).toBe("title");
    expect(p.get("direction")).toBe("asc");
    expect(p.get("limit")).toBe("5");
    expect(out.json[0]).not.toHaveProperty("dateAdded");
  });

  it("SL-06 nessun risultato con query: risultato vuoto con query e suggestion", async () => {
    h.net.on("GET", ITEMS, zList([]));
    const json = expectEmptyResult(await h.call("search_library", { query: "zzz" }), "No results found");
    expect(json.query).toBe("zzz");
    expect(json.suggestion).toBeTypeOf("string");
  });

  it("SL-07 libreria vuota senza query: risultato vuoto 'No items found'", async () => {
    h.net.on("GET", ITEMS, zList([]));
    expectEmptyResult(await h.call("search_library", {}), "No items found");
  });

  it("SL-08 unicode: query codificata correttamente e titoli/autori preservati", async () => {
    h.net.on(
      "GET",
      ITEMS,
      zList([
        article("UNI00001", {
          title: "Apprendimento profondo: 机器学习 & Müller–Ñandú 🚀",
          creators: [{ creatorType: "author", firstName: "Zoë", lastName: "Æsir-Øster" }],
        }),
      ])
    );
    const q = "Müller 机器学习 \"quoted\" & co";
    const out = await h.call("search_library", { query: q });
    expect(h.net.calls[0].url.searchParams.get("q")).toBe(q);
    expect(out.json[0].title).toBe("Apprendimento profondo: 机器学习 & Müller–Ñandú 🚀");
    expect(out.json[0].authors).toBe("Zoë Æsir-Øster");
  });

  it("SL-09 item con metadati mancanti usa i fallback (Untitled, No authors listed, No date)", async () => {
    h.net.on("GET", ITEMS, zList([{ key: "MIN00001", itemType: "book" }]));
    const out = await h.call("search_library", {});
    expect(out.json[0]).toMatchObject({
      title: "Untitled",
      authors: "No authors listed",
      date: "No date",
      key: "MIN00001",
      dateAdded: null,
    });
  });

  it("SL-10 creator istituzionale (solo name) e creator senza nome vengono ignorati nella stringa autori", async () => {
    h.net.on(
      "GET",
      ITEMS,
      zList([
        article("CRE00001", {
          creators: [
            { creatorType: "author", firstName: "", lastName: "" },
            { creatorType: "author", lastName: "Solo" },
          ],
        }),
      ])
    );
    const out = await h.call("search_library", {});
    expect(out.json[0].authors).toBe("Solo");
  });

  describe("validazione input", () => {
    it.each([
      ["sort", { sort: "relevance" }],
      ["direction", { direction: "up" }],
      ["limit", { limit: "10" }],
      ["query", { query: 42 }],
    ])("SL-11 rifiuta %s non valido senza chiamare Zotero", async (field, args) => {
      const out = await h.call("search_library", args);
      expectValidationError(out, field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  describe("errori API Zotero", () => {
    it.each(ZOTERO_ERROR_STATUSES)("SL-12 HTTP %i → isError con lo status", async (status) => {
      h.net.on("GET", ITEMS, zError(status));
      const out = await h.call("search_library", { query: "x" });
      expectToolError(out, String(status));
    });

    it("SL-13 errore di rete → isError", async () => {
      h.net.on("GET", ITEMS, networkError("getaddrinfo ENOTFOUND api.zotero.org"));
      expectToolError(await h.call("search_library", { query: "x" }), "ENOTFOUND");
    });
  });
});
