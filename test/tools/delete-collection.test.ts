import { describe, it, expect, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
} from "../helpers/mcp-harness.js";
import { networkError, jsonResponse } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zError, zDeleted, collection, zoteroEntity } from "../helpers/zotero-fake.js";
import { UnsafeOperationsMode } from "../../src/utils/unsafe-operations.js";

const COLL = `${ZBASE}/collections/COL00001`;

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
          await h.call("delete_collection", { collection_key: "COL00001" }),
          "Deletion of collections is not allowed"
        );
        expect(json).toEqual(
          expect.objectContaining({ env_var: "UNSAFE_OPERATIONS", current_value: mode, required_values: ["all"] })
        );
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
      h.net.on("GET", COLL, zSingle(collection("COL00001", "Old stuff"), 57));
      h.net.on("DELETE", COLL, zDeleted());
      const out = await h.call("delete_collection", { collection_key: "COL00001" });
      expect(out.isError).toBe(false);
      expect(out.json).toEqual({ deleted: true, collection_key: "COL00001", name: "Old stuff" });
      const [del] = h.net.requests("DELETE", COLL);
      expect(del.headers.get("If-Unmodified-Since-Version")).toBe("57");
      expect(h.net.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    });

    it("DC-04 collezione senza nome → name = chiave", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle({ key: "COL00001" }, 3));
      h.net.on("DELETE", COLL, zDeleted());
      const out = await h.call("delete_collection", { collection_key: "COL00001" });
      expect(out.json.name).toBe("COL00001");
    });

    it("DC-05 nome unicode", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("COL00001", "Архив 🗄️"), 3));
      h.net.on("DELETE", COLL, zDeleted());
      expect((await h.call("delete_collection", { collection_key: "COL00001" })).json.name).toBe("Архив 🗄️");
    });

    it("DC-06 404 sulla GET → errore strutturato 'Collection not found', nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zError(404));
      const json = expectErrorJson(await h.call("delete_collection", { collection_key: "COL00001" }), "Collection not found");
      expect(json.status).toBe("not_found");
      expect(h.net.requests("DELETE", COLL)).toHaveLength(0);
    });

    it("DC-07 404 sulla DELETE → errore strutturato 'Collection not found'", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("COL00001", "X"), 3));
      h.net.on("DELETE", COLL, zError(404));
      expectErrorJson(await h.call("delete_collection", { collection_key: "COL00001" }), "Collection not found");
    });

    it("DC-08 412 sulla DELETE → errore strutturato version_conflict", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("COL00001", "X"), 3));
      h.net.on("DELETE", COLL, zError(412, "Library has been modified since specified version"));
      const json = expectErrorJson(
        await h.call("delete_collection", { collection_key: "COL00001" }),
        "modified by another client"
      );
      expect(json.status).toBe("version_conflict");
    });

    it("DC-09 versione non determinabile (nessun header) → errore strutturato, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, jsonResponse(zoteroEntity(collection("COL00001", "X"))));
      expectErrorJson(
        await h.call("delete_collection", { collection_key: "COL00001" }),
        "Could not determine collection version"
      );
      expect(h.net.requests("DELETE", COLL)).toHaveLength(0);
    });

    it.each([403, 429, 500, 503])("DC-10 HTTP %i sulla GET → isError", async (status) => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zError(status));
      expectToolError(await h.call("delete_collection", { collection_key: "COL00001" }), String(status));
    });

    it.each([403, 429, 500])("DC-11 HTTP %i sulla DELETE → isError", async (status) => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, zSingle(collection("COL00001", "X"), 3));
      h.net.on("DELETE", COLL, zError(status));
      expectToolError(await h.call("delete_collection", { collection_key: "COL00001" }), String(status));
    });

    it("DC-12 errore di rete → isError", async () => {
      h = await startHarness({ unsafeOps: "all" });
      h.net.on("GET", COLL, networkError());
      expectToolError(await h.call("delete_collection", { collection_key: "COL00001" }));
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
