import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
  carriesApiKey,
} from "../helpers/mcp-harness.js";
import { jsonResponse, networkError } from "../helpers/fake-net.js";
import { ZBASE, zList, zSingle, zError, article, pdfAttachment } from "../helpers/zotero-fake.js";

const PARENT = `${ZBASE}/items/PARQQQQR`;
const CHILDREN = `${ZBASE}/items/PARQQQQR/children`;
const FULLTEXT = `${ZBASE}/items/ATTQQQQR/fulltext`;

function withParentAndPdf(h: Harness, fulltext: unknown = { content: "Full text body", indexedPages: 3, totalPages: 3 }) {
  h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
  h.net.on("GET", CHILDREN, zList([pdfAttachment("ATTQQQQR", "PARQQQQR")]));
  h.net.on("GET", FULLTEXT, jsonResponse(fulltext));
}

describe("get_item_fulltext (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GIF-01 item padre: trova il PDF figlio e restituisce il full text", async () => {
    withParentAndPdf(h);
    const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR" });
    expect(out.isError).toBe(false);
    expect(out.json).toEqual({
      item_key: "PARQQQQR",
      attachment_key: "ATTQQQQR",
      text: "Full text body",
      characters: 14,
      truncated: false,
      pages: 3,
      totalPages: 3,
    });
    expect(h.net.calls.map((c) => c.url.pathname)).toEqual([
      "/users/424242/items/PARQQQQR",
      "/users/424242/items/PARQQQQR/children",
      "/users/424242/items/ATTQQQQR/fulltext",
    ]);
    const ft = h.net.requests("GET", FULLTEXT)[0];
    expect(carriesApiKey(ft.headers)).toBe(true);
  });

  it("GIF-02 chiave di un allegato PDF: nessuna richiesta children", async () => {
    h.net.on("GET", `${ZBASE}/items/ATTQQQQR`, zSingle(pdfAttachment("ATTQQQQR", "PARQQQQR")));
    h.net.on("GET", FULLTEXT, jsonResponse({ content: "abc" }));
    const out = await h.call("get_item_fulltext", { item_key: "ATTQQQQR" });
    expect(out.json).toMatchObject({ item_key: "ATTQQQQR", attachment_key: "ATTQQQQR", text: "abc" });
    expect(out.json).not.toHaveProperty("pages");
    expect(h.net.requests("GET", /\/children$/)).toHaveLength(0);
  });

  it("GIF-03 tronca a max_characters", async () => {
    withParentAndPdf(h, { content: "x".repeat(1000) });
    const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR", max_characters: 100 });
    expect(out.json.text).toHaveLength(100);
    expect(out.json.characters).toBe(100);
    expect(out.json.truncated).toBe(true);
  });

  it("GIF-04 max_characters=0 significa nessun limite", async () => {
    withParentAndPdf(h, { content: "y".repeat(60000) });
    const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR", max_characters: 0 });
    expect(out.json.characters).toBe(60000);
    expect(out.json.truncated).toBe(false);
  });

  it("GIF-05 default 50000 caratteri", async () => {
    withParentAndPdf(h, { content: "z".repeat(50001) });
    const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR" });
    expect(out.json.characters).toBe(50000);
    expect(out.json.truncated).toBe(true);
  });

  it("GIF-06 sceglie il primo allegato PDF ignorando snapshot HTML e note", async () => {
    h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
    h.net.on(
      "GET",
      CHILDREN,
      zList([
        { key: "NOTE0001", itemType: "note", note: "n" },
        pdfAttachment("HTML0001", "PARQQQQR", { contentType: "text/html" }),
        pdfAttachment("ATTQQQQR", "PARQQQQR"),
        pdfAttachment("ATT00002", "PARQQQQR"),
      ])
    );
    h.net.on("GET", FULLTEXT, jsonResponse({ content: "ok" }));
    const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR" });
    expect(out.json.attachment_key).toBe("ATTQQQQR");
  });

  it("GIF-07 unicode: characters conta unità UTF-16 della stringa JS", async () => {
    withParentAndPdf(h, { content: "Grüße 你好 🚀" });
    const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR" });
    expect(out.json.text).toBe("Grüße 你好 🚀");
    expect(out.json.characters).toBe("Grüße 你好 🚀".length);
  });

  it("GIF-08 full text non indicizzato (404) → errore strutturato", async () => {
    h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
    h.net.on("GET", CHILDREN, zList([pdfAttachment("ATTQQQQR", "PARQQQQR")]));
    h.net.on("GET", FULLTEXT, zError(404));
    const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "Full text not indexed");
    expect(json).toMatchObject({ item_key: "PARQQQQR", attachment_key: "ATTQQQQR" });
  });

  it.each([403, 429, 500, 503])("GIF-09 fulltext HTTP %i → errore strutturato con lo status", async (status) => {
    h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
    h.net.on("GET", CHILDREN, zList([pdfAttachment("ATTQQQQR", "PARQQQQR")]));
    h.net.on("GET", FULLTEXT, zError(status));
    expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), `status ${status}`);
  });

  it("GIF-10 errore di rete sull'endpoint fulltext → isError", async () => {
    h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
    h.net.on("GET", CHILDREN, zList([pdfAttachment("ATTQQQQR", "PARQQQQR")]));
    h.net.on("GET", FULLTEXT, networkError("socket hang up"));
    expectToolError(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "socket hang up");
  });

  describe("nessun PDF", () => {
    it("GIF-11 item senza URL → 'No PDF attachment found'", async () => {
      h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
      h.net.on("GET", CHILDREN, zList([]));
      const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "No PDF attachment found");
      expect(json.item_key).toBe("PARQQQQR");
      expect(h.net.requests("GET", /fulltext$/)).toHaveLength(0);
    });

    it("GIF-12 item con URL → suggerisce di usare l'URL", async () => {
      h.net.on("GET", PARENT, zSingle(article("PARQQQQR", { url: "https://example.org/p" })));
      h.net.on("GET", CHILDREN, zList([]));
      const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "This item has a URL");
      expect(json.url).toBe("https://example.org/p");
    });

    it.each(["webpage", "blogPost"])("GIF-13 itemType %s → messaggio pagina web", async (itemType) => {
      h.net.on("GET", PARENT, zSingle({ key: "PARQQQQR", itemType, title: "W", url: "https://blog.example/x" }));
      h.net.on("GET", CHILDREN, zList([]));
      const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "web page item");
      expect(json.url).toBe("https://blog.example/x");
    });
  });

  it("GIF-14 item inesistente (404) → errore strutturato 'Item not found'", async () => {
    h.net.on("GET", PARENT, zError(404));
    const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "Item not found");
    expect(json.item_key).toBe("PARQQQQR");
  });

  it.each([403, 412, 429, 500, 503])("GIF-15 HTTP %i sull'item → isError", async (status) => {
    h.net.on("GET", PARENT, zError(status));
    expectToolError(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), String(status));
  });

  it("GIF-16 HTTP 500 sui children → isError", async () => {
    h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
    h.net.on("GET", CHILDREN, zError(500));
    expectToolError(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "500");
  });

  it("GIF-17 errore di rete sull'item → isError", async () => {
    h.net.on("GET", PARENT, networkError());
    expectToolError(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }));
  });

  it("GIF-18 ZOTERO_API_KEY assente → errore strutturato senza chiamate", async () => {
    await h.close();
    h = await startHarness({ envApiKey: "" });
    expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "ZOTERO_API_KEY");
    expect(h.net.calls).toHaveLength(0);
  });

  describe("validazione input", () => {
    it.each([
      ["item_key", {}],
      ["item_key", { item_key: 5 }],
      ["max_characters", { item_key: "A", max_characters: "100" }],
    ])("GIF-19 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("get_item_fulltext", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  describe("allegati linked_url (link a un PDF sul web, nessun file su Zotero)", () => {
    const linked = (key: string, parent: string) =>
      pdfAttachment(key, parent, { linkMode: "linked_url", url: "https://example.org/paper.pdf", filename: undefined });

    it("GIF-20 solo un link a un PDF → guida al link, nessuna richiesta fulltext", async () => {
      h.net.on("GET", PARENT, zSingle(article("PARQQQQR", { url: "" })));
      h.net.on("GET", CHILDREN, zList([linked("LNKQQQQR", "PARQQQQR")]));
      const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "PARQQQQR" }), "linked URL");
      expect(json).toMatchObject({ attachment_key: "LNKQQQQR", url: "https://example.org/paper.pdf" });
      expect(json.error).not.toMatch(/Open the PDF in Zotero desktop/);
      expect(h.net.requests("GET", /\/fulltext$/)).toHaveLength(0);
    });

    it("GIF-21 link elencato prima di un PDF importato → usa il PDF importato", async () => {
      h.net.on("GET", PARENT, zSingle(article("PARQQQQR")));
      h.net.on("GET", CHILDREN, zList([linked("LNKQQQQR", "PARQQQQR"), pdfAttachment("ATTQQQQR", "PARQQQQR")]));
      h.net.on("GET", FULLTEXT, jsonResponse({ content: "Stored PDF text" }));
      const out = await h.call("get_item_fulltext", { item_key: "PARQQQQR" });
      expect(out.isError).toBe(false);
      expect(out.json).toMatchObject({ attachment_key: "ATTQQQQR", text: "Stored PDF text" });
    });

    it("GIF-22 chiave di un allegato linked_url → guida al link, nessuna richiesta fulltext", async () => {
      h.net.on("GET", `${ZBASE}/items/LNKQQQQR`, zSingle(linked("LNKQQQQR", "PARQQQQR")));
      const json = expectErrorJson(await h.call("get_item_fulltext", { item_key: "LNKQQQQR" }), "linked URL");
      expect(json.url).toBe("https://example.org/paper.pdf");
      expect(h.net.requests("GET", /\/fulltext$/)).toHaveLength(0);
    });
  });
});
