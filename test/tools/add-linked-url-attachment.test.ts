import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectSoftError,
  expectToolError,
  ZOTERO_ERROR_STATUSES,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zWrite, zError } from "../helpers/zotero-fake.js";

const ITEMS = `${ZBASE}/items`;
const URL_ = "https://arxiv.org/pdf/2301.00001.pdf";

describe("add_linked_url_attachment (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("ALU-01 allegato standalone con solo url", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["LINK0001"] }));
    const out = await h.call("add_linked_url_attachment", { url: URL_ });
    expect(out.isError).toBe(false);
    expect(out.json).toEqual({
      item_key: "LINK0001",
      title: URL_,
      url: URL_,
      parent_item: null,
      link_mode: "linked_url",
    });
    expect(h.net.calls[0].json()).toEqual([
      { itemType: "attachment", linkMode: "linked_url", title: URL_, url: URL_, tags: [], collections: [] },
    ]);
  });

  it("ALU-02 allegato figlio: parentItem, contentType, collections forzate a []", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["LINK0002"] }));
    const out = await h.call("add_linked_url_attachment", {
      url: URL_,
      title: "Preprint",
      content_type: "application/pdf",
      parent_item: "PAR00001",
      collections: ["COL00001"],
    });
    expect(out.json).toMatchObject({ item_key: "LINK0002", title: "Preprint", parent_item: "PAR00001" });
    expect(h.net.calls[0].json()).toEqual([
      expect.objectContaining({ parentItem: "PAR00001", contentType: "application/pdf", collections: [] }),
    ]);
  });

  it("ALU-03 standalone: collections e tags applicati", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["LINK0003"] }));
    await h.call("add_linked_url_attachment", { url: URL_, collections: ["C1", "C2"], tags: ["oa", "pdf"] });
    expect(h.net.calls[0].json()).toEqual([
      expect.objectContaining({ collections: ["C1", "C2"], tags: [{ tag: "oa" }, { tag: "pdf" }] }),
    ]);
  });

  it("ALU-04 unicode in titolo e URL con caratteri non ASCII", async () => {
    h.net.on("POST", ITEMS, zWrite({ keys: ["LINK0004"] }));
    const url = "https://example.org/articolo/perché-研究.pdf";
    const out = await h.call("add_linked_url_attachment", { url, title: "Perché 研究" });
    expect(out.json.title).toBe("Perché 研究");
    expect(h.net.calls[0].json<Array<{ url: string }>>()[0].url).toBe(url);
  });

  it("ALU-05 scrittura rifiutata → errore morbido con details", async () => {
    h.net.on("POST", ITEMS, zWrite({ fail: { 0: { code: 400, message: "Parent item PAR00001 not found" } } }));
    const json = expectSoftError(
      await h.call("add_linked_url_attachment", { url: URL_, parent_item: "PAR00001" }),
      "Failed to create linked URL attachment"
    );
    expect(json).toHaveProperty("details");
  });

  // BUG: add-linked-url-attachment.ts:78 — stesso problema di create_collection:
  // gli errori sono oggetti, details diventa "[object Object]".
  it.fails("ALU-06 BUG details riporta il messaggio d'errore del server", async () => {
    h.net.on("POST", ITEMS, zWrite({ fail: { 0: { code: 400, message: "Parent item PAR00001 not found" } } }));
    const out = await h.call("add_linked_url_attachment", { url: URL_, parent_item: "PAR00001" });
    expect(out.json.details).toContain("Parent item PAR00001 not found");
  });

  describe("validazione input", () => {
    it.each([
      ["url", {}],
      ["url", { url: "not a url" }],
      ["url", { url: 123 }],
      ["tags", { url: URL_, tags: "oa" }],
      ["collections", { url: URL_, collections: "C1" }],
    ])("ALU-07 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("add_linked_url_attachment", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  it.each(ZOTERO_ERROR_STATUSES)("ALU-08 HTTP %i → isError", async (status) => {
    h.net.on("POST", ITEMS, zError(status));
    expectToolError(await h.call("add_linked_url_attachment", { url: URL_ }), String(status));
  });

  it("ALU-09 errore di rete → isError", async () => {
    h.net.on("POST", ITEMS, networkError());
    expectToolError(await h.call("add_linked_url_attachment", { url: URL_ }));
  });
});
