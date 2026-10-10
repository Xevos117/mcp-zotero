import { describe, it, expect, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
} from "../helpers/mcp-harness.js";
import { networkError, jsonResponse } from "../helpers/fake-net.js";
import { ZBASE, zError, zDeleted, zLibraryQuery, article, manyArticles, zoteroEntity } from "../helpers/zotero-fake.js";
import { UnsafeOperationsMode } from "../../src/utils/unsafe-operations.js";

const ITEMS = `${ZBASE}/items`;

function deletedKeys(h: Harness): string[] {
  return h.net
    .requests("DELETE", ITEMS)
    .flatMap((r) => (r.url.searchParams.get("itemKey") ?? "").split(",").filter(Boolean));
}

describe("delete_items (MCP)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  describe("guard UNSAFE_OPERATIONS", () => {
    it("DI-01 modalità 'none' → rifiutato, nessuna chiamata di rete", async () => {
      h = await startHarness({ unsafeOps: "none" });
      const json = expectErrorJson(
        await h.call("delete_items", { item_keys: ["AAAA1111"] }),
        "Deletion of items is not allowed"
      );
      expect(json).toEqual(
        expect.objectContaining({ env_var: "UNSAFE_OPERATIONS", current_value: "none", required_values: ["items", "all"] })
      );
      expect(h.net.calls).toHaveLength(0);
    });

    it.each<UnsafeOperationsMode>(["items", "all"])("DI-02 modalità '%s' → consentito", async (mode) => {
      h = await startHarness({ unsafeOps: mode });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")], 88));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAA1111"] });
      expect(out.isError).toBe(false);
      expect(out.json).toEqual({ deleted_keys: ["AAAA1111"], deleted_count: 1 });
    });
  });

  describe("modalità 'items'", () => {
    it("DI-03 GET itemKey poi DELETE ?itemKey con la versione di libreria", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111"), article("BBBB2222")], 88));
      h.net.on("DELETE", ITEMS, zDeleted());
      await h.call("delete_items", { item_keys: ["AAAA1111", "BBBB2222"] });
      expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("itemKey")).toBe("AAAA1111,BBBB2222");
      const [del] = h.net.requests("DELETE", ITEMS);
      expect(del.headers.get("If-Unmodified-Since-Version")).toBe("88");
      expect(deletedKeys(h)).toEqual(["AAAA1111", "BBBB2222"]);
    });

    it("DI-04 cancellazione parziale: chiavi mancanti in not_found, cancellate solo quelle trovate", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")]));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAA1111", "GONE0001"] });
      expect(out.json).toEqual({ deleted_keys: ["AAAA1111"], deleted_count: 1, not_found: ["GONE0001"] });
      expect(deletedKeys(h)).toEqual(["AAAA1111"]);
    });

    it("DI-05 nessuna chiave trovata → errore strutturato not_found, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([]));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["GONE0001"] }), "No items found");
      expect(json.status).toBe("not_found");
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(0);
    });

    it("DI-06 412 sulla DELETE → errore strutturato version_conflict", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")]));
      h.net.on("DELETE", ITEMS, zError(412));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["AAAA1111"] }), "modified by another client");
      expect(json.status).toBe("version_conflict");
    });

    it("DI-07 versione di libreria assente → errore strutturato, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, jsonResponse([zoteroEntity(article("AAAA1111"))]));
      expectErrorJson(await h.call("delete_items", { item_keys: ["AAAA1111"] }), "Could not determine library version");
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(0);
    });

    it("DI-08 batch di 20 chiavi → una GET e una DELETE con tutte le chiavi", async () => {
      h = await startHarness({ unsafeOps: "items" });
      const lib = manyArticles(20);
      h.net.on("GET", ITEMS, zLibraryQuery(lib));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: lib.map((i) => i.key) });
      expect(out.json.deleted_count).toBe(20);
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(1);
    });

    // Dal vivo una GET con itemKey non applica il default di 25: con il massimo di 50 chiavi
    // per chiamata delete_items non perdeva item nemmeno su main. Resta come regressione
    // sul caso limite, con limit esplicito nella GET di verifica.
    it("DI-09 50 chiavi esistenti: tutte cancellate, GET di verifica con limit=50", async () => {
      h = await startHarness({ unsafeOps: "items" });
      const lib = manyArticles(50);
      h.net.on("GET", ITEMS, zLibraryQuery(lib));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: lib.map((i) => i.key) });
      expect(out.json.not_found).toBeUndefined();
      expect(deletedKeys(h)).toHaveLength(50);
      expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("limit")).toBe("50");
    });

    it.each([403, 404, 429, 500, 503])("DI-10 HTTP %i sulla GET → isError", async (status) => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zError(status));
      expectToolError(await h.call("delete_items", { item_keys: ["AAAA1111"] }), String(status));
    });

    it.each([403, 429, 500])("DI-11 HTTP %i sulla DELETE → isError", async (status) => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA1111")]));
      h.net.on("DELETE", ITEMS, zError(status));
      expectToolError(await h.call("delete_items", { item_keys: ["AAAA1111"] }), String(status));
    });

    it("DI-12 errore di rete → isError", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, networkError());
      expectToolError(await h.call("delete_items", { item_keys: ["AAAA1111"] }));
    });

    describe("validazione input", () => {
      it.each([
        ["item_keys", {}],
        ["item_keys", { item_keys: [] }],
        ["item_keys", { item_keys: "AAAA1111" }],
        ["item_keys", { item_keys: manyArticles(51).map((i) => i.key) }],
      ])("DI-13 rifiuta %s non valido", async (field, args) => {
        h = await startHarness({ unsafeOps: "items" });
        expectValidationError(await h.call("delete_items", args), field);
        expect(h.net.calls).toHaveLength(0);
      });

      it("DI-14 esattamente 50 chiavi accettate dalla validazione", async () => {
        h = await startHarness({ unsafeOps: "items" });
        const keys = manyArticles(50).map((i) => i.key);
        h.net.on("GET", ITEMS, zLibraryQuery([]));
        const out = await h.call("delete_items", { item_keys: keys });
        expectErrorJson(out, "No items found");
      });

      it("DI-15 la validazione precede il guard", async () => {
        h = await startHarness({ unsafeOps: "none" });
        expectValidationError(await h.call("delete_items", { item_keys: [] }), "item_keys");
      });
    });
  });
});
