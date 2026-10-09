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

const COLLS = `${ZBASE}/collections`;

describe("create_collection (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("CC-01 POST /collections con [{name}] → collection_key e name", async () => {
    h.net.on("POST", COLLS, zWrite({ keys: ["NEWCOL01"] }));
    const out = await h.call("create_collection", { name: "Thesis" });
    expect(out.isError).toBe(false);
    expect(out.json).toEqual({ collection_key: "NEWCOL01", name: "Thesis" });
    const [req] = h.net.requests("POST", COLLS);
    expect(req.json()).toEqual([{ name: "Thesis" }]);
  });

  it("CC-02 parent_collection → parentCollection nel body", async () => {
    h.net.on("POST", COLLS, zWrite({ keys: ["NEWCOL02"] }));
    await h.call("create_collection", { name: "Chapter 1", parent_collection: "PARENT01" });
    expect(h.net.calls[0].json()).toEqual([{ name: "Chapter 1", parentCollection: "PARENT01" }]);
  });

  it("CC-03 il nome viene trimmato", async () => {
    h.net.on("POST", COLLS, zWrite({ keys: ["NEWCOL03"] }));
    const out = await h.call("create_collection", { name: "   Spaced   " });
    expect(h.net.calls[0].json()).toEqual([{ name: "Spaced" }]);
    expect(out.json.name).toBe("Spaced");
  });

  it.each(["", "   ", "\t\n"])("CC-04 nome vuoto/solo spazi (%j) → errore morbido, nessuna POST", async (name) => {
    expectSoftError(await h.call("create_collection", { name }), "Collection name is required");
    expect(h.net.calls).toHaveLength(0);
  });

  it("CC-05 unicode nel nome", async () => {
    h.net.on("POST", COLLS, zWrite({ keys: ["NEWCOL05"] }));
    const out = await h.call("create_collection", { name: "Résumé 研究 🧪" });
    expect(h.net.calls[0].json()).toEqual([{ name: "Résumé 研究 🧪" }]);
    expect(out.json.name).toBe("Résumé 研究 🧪");
  });

  it("CC-06 scrittura rifiutata (failed) → errore morbido 'Failed to create collection'", async () => {
    h.net.on("POST", COLLS, zWrite({ fail: { 0: { code: 400, message: "Parent collection PARENT01 not found" } } }));
    const json = expectSoftError(
      await h.call("create_collection", { name: "X", parent_collection: "PARENT01" }),
      "Failed to create collection"
    );
    expect(json).toHaveProperty("details");
  });

  // BUG: create-collection.ts:47 fa `Object.values(errors).join("; ")` ma gli
  // errori di zotero-api-client sono oggetti {key, code, message} → details
  // diventa "[object Object]" e il messaggio del server va perso.
  it("CC-07 details riporta il messaggio d'errore del server", async () => {
    h.net.on("POST", COLLS, zWrite({ fail: { 0: { code: 400, message: "Parent collection PARENT01 not found" } } }));
    const out = await h.call("create_collection", { name: "X", parent_collection: "PARENT01" });
    expect(out.json.details).toContain("Parent collection PARENT01 not found");
  });

  describe("validazione input", () => {
    it.each([
      ["name", {}],
      ["name", { name: 42 }],
      ["parent_collection", { name: "X", parent_collection: 7 }],
    ])("CC-08 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("create_collection", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });

  it.each([...ZOTERO_ERROR_STATUSES, 413])("CC-09 HTTP %i → isError", async (status) => {
    h.net.on("POST", COLLS, zError(status));
    expectToolError(await h.call("create_collection", { name: "X" }), String(status));
  });

  it("CC-10 errore di rete → isError", async () => {
    h.net.on("POST", COLLS, networkError());
    expectToolError(await h.call("create_collection", { name: "X" }));
  });
});
