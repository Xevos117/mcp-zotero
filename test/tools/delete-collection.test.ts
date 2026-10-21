import { describe, it, expect, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
  expectApiError,
} from "../helpers/mcp-harness.js";
import { networkError, jsonResponse } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zError, zDeleted, collection, zoteroEntity } from "../helpers/zotero-fake.js";
import { UnsafeOperationsMode } from "../../src/utils/unsafe-operations.js";

const COLL = `${ZBASE}/collections/CPLQQQQR`;

describe("delete_collection (MCP)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  describe("guard UNSAFE_OPERATIONS", () => {
    it.each<UnsafeOperationsMode>(["none", "items"])(
      "DC-01 modalità '%s' → rifiutato, nessuna chiamata di rete",
      async (mode) => {
        h = await startHarness({ unsafeOps: mode });
        const json = expectErrorJson(
          await h.call("delete_collection", { collection_key: "CPLQQQQR" }),
          "Deletion of collections is not allowed"
        );
        expect(json).toEqual(
          expect.objectContaining({ env_var: "UNSAFE_OPERATIONS", current_value: mode, required_values: ["all"] })
        );
        expect(json.error).toContain(`needs UNSAFE_OPERATIONS 'all' in this server's configuration (it is '${mode}'). Nothing was deleted.`);
        expect(json.hint).toMatch(/^Do not try to get around this with other tools/);
        expect(json.hint).toContain("'all' (allows delete_collection and delete_items; 'items' allows only delete_items)");
        expect(json.hint).toMatch(/restart the client/);
        expect(h.net.calls).toHaveLength(0);
      }
    );

    it("DC-02 la validazione degli argomenti precede il guard", async () => {
      h = await startHarness({ unsafeOps: "none" });
      expectValidationError(await h.call("delete_collection", {}), "collection_key");
    });
  });

  describe("modalità 'all'", () => {
    it("DC-03 GET versione poi DELETE con If-Unmodified-Since-Version", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("CPLQQQQR", "Old stuff"), 57));
      h.net.on("DELETE", COLL, zDeleted());
      const out = await h.call("delete_collection", { collection_key: "CPLQQQQR" });
      expect(out.isError).toBe(false);
      expect(out.json).toEqual({ deleted: true, collection_key: "CPLQQQQR", name: "Old stuff" });
      const [del] = h.net.requests("DELETE", COLL);
      expect(del.headers.get("If-Unmodified-Since-Version")).toBe("57");
      expect(h.net.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    });

    it("DC-04 collezione senza nome → name = chiave", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle({ key: "CPLQQQQR" }, 3));
      h.net.on("DELETE", COLL, zDeleted());
      const out = await h.call("delete_collection", { collection_key: "CPLQQQQR" });
      expect(out.json.name).toBe("CPLQQQQR");
    });

    it("DC-05 nome unicode", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("CPLQQQQR", "Архив 🗄️"), 3));
      h.net.on("DELETE", COLL, zDeleted());
      expect((await h.call("delete_collection", { collection_key: "CPLQQQQR" })).json.name).toBe("Архив 🗄️");
    });

    it("DC-06 404 sulla GET → errore strutturato 'Collection not found', nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zError(404));
      const json = expectErrorJson(await h.call("delete_collection", { collection_key: "CPLQQQQR" }), "Collection not found");
      expect(json.status).toBe("not_found");
      expect(json.hint).toMatch(/^Nothing was deleted\. Get valid collection keys from get_collections/);
      expect(h.net.requests("DELETE", COLL)).toHaveLength(0);
    });

    it("DC-07 404 sulla DELETE → errore strutturato 'Collection not found'", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("CPLQQQQR", "X"), 3));
      h.net.on("DELETE", COLL, zError(404));
      expectErrorJson(await h.call("delete_collection", { collection_key: "CPLQQQQR" }), "Collection not found");
    });

    it("DC-08 412 sulla DELETE → errore strutturato version_conflict", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("CPLQQQQR", "X"), 3));
      h.net.on("DELETE", COLL, zError(412, "Library has been modified since specified version"));
      const json = expectErrorJson(
        await h.call("delete_collection", { collection_key: "CPLQQQQR" }),
        "modified by another client"
      );
      expect(json.error).toMatch(/so it was not deleted\. Retry the same call\./);
      expect(json.status).toBe("version_conflict");
    });

    it("DC-09 versione non determinabile (nessun header) → errore strutturato, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, jsonResponse(zoteroEntity(collection("CPLQQQQR", "X"))));
      const json = expectErrorJson(
        await h.call("delete_collection", { collection_key: "CPLQQQQR" }),
        "Could not determine collection version"
      );
      expect(json.hint).toBe("Nothing was deleted. Retry the same call once.");
      expect(h.net.requests("DELETE", COLL)).toHaveLength(0);
    });

    it.each([403, 429, 500, 503])("DC-10 HTTP %i sulla GET → isError", async (status) => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zError(status));
      expectApiError(await h.call("delete_collection", { collection_key: "CPLQQQQR" }), status);
    });

    it.each([403, 429, 500])("DC-11 HTTP %i sulla DELETE → isError", async (status) => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("CPLQQQQR", "X"), 3));
      h.net.on("DELETE", COLL, zError(status));
      expectApiError(await h.call("delete_collection", { collection_key: "CPLQQQQR" }), status);
    });

    it("DC-12 errore di rete → isError", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, networkError());
      expectApiError(await h.call("delete_collection", { collection_key: "CPLQQQQR" }));
    });

    it.each([
      ["collection_key", {}],
      ["collection_key", { collection_key: "" }],
      ["collection_key", { collection_key: 12 }],
    ])("DC-13 rifiuta %s non valido (%j)", async (field, args) => {
      h = await startHarness({ unsafeOps: "all" });
      expectValidationError(await h.call("delete_collection", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });
});
