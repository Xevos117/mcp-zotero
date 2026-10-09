import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
  ZOTERO_ERROR_STATUSES,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zWrite, zError } from "../helpers/zotero-fake.js";

const ITEMS = `${ZBASE}/items`;

type Posted = Record<string, unknown>;
const posted = (h: Harness, n = 0) => h.net.requests("POST", ITEMS)[n].json<Posted[]>();

describe("add_items (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("AI-01 singolo book: payload completo e risultato per-item", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["BOOK0001"] }));
    const out = await h.call("add_items", {
      items: [
        {
          itemType: "book",
          title: "The Art of Computer Programming",
          creators: [{ firstName: "Donald", lastName: "Knuth" }],
          publisher: "Addison-Wesley",
          date: "1968",
        },
      ],
    });
    expect(out.isError).toBe(false);
    expect(out.json).toEqual({
      success: [{ index: 0, item_key: "BOOK0001", title: "The Art of Computer Programming", item_type: "book" }],
    });
    expect(posted(h)).toEqual([
      {
        itemType: "book",
        title: "The Art of Computer Programming",
        publisher: "Addison-Wesley",
        date: "1968",
        creators: [{ firstName: "Donald", lastName: "Knuth", creatorType: "author" }],
        collections: [],
        tags: [],
      },
    ]);
  });

  it("AI-02 batch di tipi misti in un'unica POST", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["K0", "K1", "K2"] }));
    const out = await h.call("add_items", {
      items: [
        { itemType: "journalArticle", title: "A", publicationTitle: "Nature", DOI: "10.1/x" },
        { itemType: "thesis", title: "B", university: "MIT", thesisType: "PhD thesis" },
        { itemType: "conferencePaper", title: "C", proceedingsTitle: "NeurIPS" },
      ],
    });
    expect(out.json.success.map((s: { item_key: string }) => s.item_key)).toEqual(["K0", "K1", "K2"]);
    expect(h.net.requests("POST", ITEMS)).toHaveLength(1);
    expect(posted(h).map((p) => p.itemType)).toEqual(["journalArticle", "thesis", "conferencePaper"]);
  });

  it.each([
    ["case", "caseName"],
    ["email", "subject"],
    ["statute", "nameOfAct"],
  ])("AI-03 itemType %s: title mappato sul campo %s", async (itemType, field) => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["T0000001"] }));
    await h.call("add_items", { items: [{ itemType, title: "Roe v. Wade" }] });
    const body = posted(h)[0];
    expect(body[field]).toBe("Roe v. Wade");
    expect(body).not.toHaveProperty("title");
  });

  it("AI-04 collection_key e tags applicati a tutti gli item", async () => {
    h.net.on("POST", ITEMS, zWrite());
    await h.call("add_items", {
      items: [
        { itemType: "book", title: "A" },
        { itemType: "report", title: "B" },
      ],
      collection_key: "COL00001",
      tags: ["to-read", "ai"],
    });
    for (const p of posted(h)) {
      expect(p.collections).toEqual(["COL00001"]);
      expect(p.tags).toEqual([{ tag: "to-read" }, { tag: "ai" }]);
    }
  });

  it("AI-05 url senza accessDate → accessDate di oggi (YYYY-MM-DD); accessDate esplicito preservato", async () => {
    h.net.on("POST", ITEMS, zWrite());
    await h.call("add_items", {
      items: [
        { itemType: "webpage", title: "A", url: "https://a.example" },
        { itemType: "webpage", title: "B", url: "https://b.example", accessDate: "2020-01-02" },
        { itemType: "webpage", title: "C" },
      ],
    });
    const [a, b, c] = posted(h);
    expect(a.accessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(b.accessDate).toBe("2020-01-02");
    expect(c).not.toHaveProperty("accessDate");
  });

  it("AI-06 creator istituzionale (name) e creatorType specifici del tipo", async () => {
    h.net.on("POST", ITEMS, zWrite());
    await h.call("add_items", {
      items: [
        {
          itemType: "film",
          title: "Metropolis",
          creators: [
            { firstName: "Fritz", lastName: "Lang", creatorType: "director" },
            { name: "UFA", creatorType: "producer" },
          ],
        },
      ],
    });
    expect(posted(h)[0].creators).toEqual([
      { firstName: "Fritz", lastName: "Lang", creatorType: "director" },
      { name: "UFA", creatorType: "producer" },
    ]);
  });

  it("AI-07 unicode in titolo, creator e campi", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["UNI00001"] }));
    const out = await h.call("add_items", {
      items: [
        {
          itemType: "book",
          title: "Il nome della rosa — 玫瑰的名字 🌹",
          creators: [{ firstName: "Umberto", lastName: "Eco" }, { name: "Società Editrice «Ñ»" }],
          place: "Milano",
        },
      ],
    });
    expect(out.json.success[0].title).toBe("Il nome della rosa — 玫瑰的名字 🌹");
    expect(posted(h)[0].creators).toEqual(
      expect.arrayContaining([{ name: "Società Editrice «Ñ»", creatorType: "author" }])
    );
  });

  it("AI-08 fallimento parziale sull'ultimo indice: success e failed corretti", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["OK000000"], fail: { 1: { code: 400, message: "Invalid date 'xyz'" } } }));
    const out = await h.call("add_items", {
      items: [
        { itemType: "book", title: "Good" },
        { itemType: "book", title: "Bad", date: "xyz" },
      ],
    });
    expect(out.isError).toBe(false);
    expect(out.json.success).toEqual([{ index: 0, item_key: "OK000000", title: "Good", item_type: "book" }]);
    expect(out.json.failed).toHaveLength(1);
    expect(out.json.failed[0]).toMatchObject({ index: 1, title: "Bad" });
    expect(JSON.stringify(out.json.failed[0].error)).toContain("Invalid date");
  });

  // BUG: add-items.ts:179 assume che response.getData() contenga solo gli item
  // creati, ma zotero-api-client restituisce TUTTI gli item inviati (quelli
  // falliti senza key) → se fallisce un indice non finale, i successivi
  // ricevono item_key/title dell'item sbagliato ("unknown" / titolo del fallito).
  it("AI-09 fallimento parziale al primo indice: item_key/title assegnati all'item giusto", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["SKIP", "OK000001"], fail: { 0: { code: 400, message: "Invalid date" } } }));
    const out = await h.call("add_items", {
      items: [
        { itemType: "book", title: "Bad", date: "xyz" },
        { itemType: "book", title: "Good" },
      ],
    });
    expect(out.isError).toBe(false); // successo parziale: non è un errore del tool
    expect(out.json.success).toEqual([{ index: 1, item_key: "OK000001", title: "Good", item_type: "book" }]);
  });

  // BUG: add-items.ts:172 copia in `failed[].error` l'oggetto errore grezzo
  // ({key, code, message}) invece di una stringa, come documentato dal tipo.
  it("AI-10 failed[].error è una stringa leggibile", async () => {
    h.net.on("POST", ITEMS, zWrite({ fail: { 0: { code: 400, message: "Invalid date" } } }));
    const out = await h.call("add_items", { items: [{ itemType: "book", title: "Bad" }, { itemType: "book", title: "x" }] });
    expect(out.json.failed[0].error).toBe("400: Invalid date");
  });

  it("AI-11 tutti falliti → errore strutturato 'All items failed to create' con elenco", async () => {
    h.net.on(
      "POST",
      ITEMS,
      zWrite({ fail: { 0: { code: 400, message: "e0" }, 1: { code: 400, message: "e1" } } })
    );
    const json = expectErrorJson(
      await h.call("add_items", { items: [{ itemType: "book", title: "A" }, { itemType: "book", title: "B" }] }),
      "All items failed to create"
    );
    expect(json.failed.map((f: { index: number }) => f.index)).toEqual([0, 1]);
  });

  it("AI-12 batch di 50 item → una sola POST con 50 oggetti", async () => {
    h.net.on("POST", ITEMS, zWrite());
    const items = Array.from({ length: 50 }, (_, i) => ({ itemType: "book", title: `Book ${i}` }));
    const out = await h.call("add_items", { items });
    expect(out.json.success).toHaveLength(50);
    expect(posted(h)).toHaveLength(50);
  });

  // BUG: add_items non ha .max(50) né chunking: l'API Zotero accetta al massimo
  // 50 oggetti per POST (oltre risponde 413), quindi un batch di 60 fallisce tutto.
  it("AI-13 batch di 60 item: suddiviso in POST da ≤50 oppure rifiutato in validazione", async () => {
    h.net.on("POST", ITEMS, (req, hit) => {
      const n = req.json<unknown[]>().length;
      if (n > 50) return zError(413, "Too many objects (max 50)");
      return zWrite({ keys: Array.from({ length: n }, (_, i) => `B${hit}${String(i).padStart(6, "0")}`) })(req, hit);
    });
    const items = Array.from({ length: 60 }, (_, i) => ({ itemType: "book", title: `Book ${i}` }));
    const out = await h.call("add_items", { items });
    expect(out.isError).toBe(false);
    expect(h.net.requests("POST", ITEMS).map((r) => r.json<unknown[]>().length)).toEqual([50, 10]);
    expect(out.json.success.map((s: { index: number }) => s.index)).toEqual(items.map((_, i) => i));
    expect(new Set(out.json.success.map((s: { item_key: string }) => s.item_key)).size).toBe(60);
  });

  it("AI-13b fallimento nel secondo batch: indici e titoli riferiti all'input originale", async () => {
    h.net.on("POST", ITEMS, (req, hit) =>
      zWrite({ fail: hit === 2 ? { 5: { code: 400, message: "Invalid date" } } : {} })(req, hit)
    );
    const items = Array.from({ length: 60 }, (_, i) => ({ itemType: "book", title: `Book ${i}` }));
    const out = await h.call("add_items", { items });
    expect(out.isError).toBe(false);
    expect(out.json.failed).toEqual([{ index: 55, title: "Book 55", error: "400: Invalid date" }]);
    expect(out.json.success).toHaveLength(59);
    expect(out.json.success.find((s: { index: number }) => s.index === 56).title).toBe("Book 56");
  });

  describe("validazione input", () => {
    it.each([
      ["items", {}],
      ["items", { items: [] }],
      ["itemType", { items: [{ itemType: "spaceship", title: "X" }] }],
      ["title", { items: [{ itemType: "book" }] }],
      ["publicationTitle", { items: [{ itemType: "book", title: "X", publicationTitle: "Nature" }] }],
      ["creatorType", { items: [{ itemType: "book", title: "X", creators: [{ name: "N", creatorType: "director" }] }] }],
      ["creators", { items: [{ itemType: "book", title: "X", creators: [{ firstName: "Only" }] }] }],
      ["volume", { items: [{ itemType: "journalArticle", title: "X", volume: 12 }] }],
      ["tags", { items: [{ itemType: "book", title: "X" }], tags: "t" }],
      ["collection_key", { items: [{ itemType: "book", title: "X" }], collection_key: 1 }],
    ])("AI-14 rifiuta input non valido su '%s'", async (field, args) => {
      expectValidationError(await h.call("add_items", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  it.each([...ZOTERO_ERROR_STATUSES, 413])("AI-15 HTTP %i sulla POST → isError", async (status) => {
    h.net.on("POST", ITEMS, zError(status));
    expectToolError(await h.call("add_items", { items: [{ itemType: "book", title: "X" }] }), String(status));
  });

  it("AI-16 errore di rete → isError", async () => {
    h.net.on("POST", ITEMS, networkError());
    expectToolError(await h.call("add_items", { items: [{ itemType: "book", title: "X" }] }));
  });
});
