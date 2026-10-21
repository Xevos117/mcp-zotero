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
        await h.call("delete_items", { item_keys: ["AAAARRRR"] }),
        "Deletion of items is not allowed"
      );
      expect(json).toEqual(
        expect.objectContaining({ env_var: "UNSAFE_OPERATIONS", current_value: "none", required_values: ["items", "all"] })
      );
      expect(json.error).toMatch(/disabled in this server's configuration \(UNSAFE_OPERATIONS is 'none'\)\. Nothing was deleted\./);
      // il modello deve spiegarlo all'utente (valori, dove impostarli, riavvio) e non aggirare il blocco
      expect(json.hint).toMatch(/^Do not try to get around this with other tools/);
      expect(json.hint).toContain("'items' (allows delete_items) or 'all' (also delete_collection)");
      expect(json.hint).toMatch(/server's settings: with the Claude Desktop extension, "Deletions allowed" .*UNSAFE_OPERATIONS in the env block .*claude_desktop_config\.json or \.mcp\.json.*restart the client/);
      expect(h.net.calls).toHaveLength(0);
    });

    it.each<UnsafeOperationsMode>(["items", "all"])("DI-02 modalità '%s' → consentito", async (mode) => {
      h = await startHarness({ unsafeOps: mode });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")], 88));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR"] });
      expect(out.isError).toBe(false);
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1 });
    });
  });

  // Comportamento reale della Web API (verificato il 2026-10-11): se nessuna chiave di itemKey ha la forma
  // valida ("zzzzzzzz", "ZZZZZZZ0") il filtro viene ignorato e torna la libreria intera.
  describe("chiavi malformate (bug di perdita dati fino alla 2.0.0)", () => {
    const LIBRARY = [article("KEEP2222"), article("KEEP3333"), article("KEEP4444")];
    /** API che ignora il filtro itemKey, come quella reale con chiavi malformate. */
    function libraryIgnoringFilter(hh: Harness) {
      hh.net.on("GET", ITEMS, (req, hit) => {
        const u = new URL(req.url.href);
        u.searchParams.delete("itemKey");
        return zLibraryQuery(LIBRARY, 77)({ ...req, url: u }, hit);
      });
    }

    it("DI-16 chiave malformata → errore di validazione prima di qualsiasi richiesta", async () => {
      h = await startHarness({ unsafeOps: "items" });
      libraryIgnoringFilter(h);
      expectValidationError(await h.call("delete_items", { item_keys: ["zzzzzzzz"] }), "item_keys");
      expect(h.net.calls).toHaveLength(0);
    });

    it("DI-17 API che restituisce più voci di quelle chieste → cancellata solo la chiave richiesta", async () => {
      h = await startHarness({ unsafeOps: "items" });
      libraryIgnoringFilter(h);
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["KEEP2222"] });
      expect(out.json).toEqual({ deleted_keys: ["KEEP2222"], deleted_count: 1 });
      expect(deletedKeys(h)).toEqual(["KEEP2222"]);
    });
  });

  describe("modalità 'items'", () => {
    it("DI-03 GET itemKey poi DELETE ?itemKey con la versione di libreria", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR"), article("BBBB2222")], 88));
      h.net.on("DELETE", ITEMS, zDeleted());
      await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"] });
      expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("itemKey")).toBe("AAAARRRR,BBBB2222");
      const [del] = h.net.requests("DELETE", ITEMS);
      expect(del.headers.get("If-Unmodified-Since-Version")).toBe("88");
      expect(deletedKeys(h)).toEqual(["AAAARRRR", "BBBB2222"]);
    });

    it("DI-04 cancellazione parziale: chiavi mancanti in not_found, cancellate solo quelle trovate", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "GPNEQQQR"] });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, not_found: ["GPNEQQQR"] });
      expect(deletedKeys(h)).toEqual(["AAAARRRR"]);
    });

    it("DI-05 nessuna chiave trovata → errore strutturato not_found, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([]));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["GPNEQQQR"] }), "No items found");
      expect(json.status).toBe("not_found");
      expect(json.hint).toMatch(/^Nothing was deleted: none of these keys exists.*search_library/);
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(0);
    });

    it("DI-06 412 ripetuto sulla DELETE → errore version_conflict con http_status e hint, al massimo 2 DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("DELETE", ITEMS, zError(412));
      const json = expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), 412);
      expect(json.error).toMatch(/modified by another client .*also on a second try.*so nothing was deleted\./);
      expect(json.status).toBe("version_conflict");
      expect(json.hint).toBe("Retry the same call once.");
      expect(json.deleted_count).toBeUndefined();
      expect(h.net.requests("GET", ITEMS)).toHaveLength(2);
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(2);
    });

    it("DI-06b 412 poi successo → nuova GET, seconda DELETE con la nuova versione", async () => {
      h = await startHarness({ unsafeOps: "items" });
      const lib = [article("AAAARRRR"), article("BBBB2222")];
      h.net.on("GET", ITEMS, (req, hit) => zLibraryQuery(lib, hit === 1 ? 88 : 89)(req, hit));
      h.net.on("DELETE", ITEMS, (_req, hit) => (hit === 1 ? zError(412) : zDeleted()));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"] });
      expect(out.isError).toBe(false);
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR", "BBBB2222"], deleted_count: 2 });
      expect(h.net.requests("GET", ITEMS)).toHaveLength(2);
      const dels = h.net.requests("DELETE", ITEMS);
      expect(dels.map((d) => d.headers.get("If-Unmodified-Since-Version"))).toEqual(["88", "89"]);
    });

    it("DI-06c 412, nel frattempo una chiave è sparita → seconda DELETE solo sulle rimaste, la sparita in not_found", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, (req, hit) =>
        zLibraryQuery(hit === 1 ? [article("AAAARRRR"), article("BBBB2222")] : [article("AAAARRRR")], 88 + hit)(req, hit)
      );
      h.net.on("DELETE", ITEMS, (_req, hit) => (hit === 1 ? zError(412) : zDeleted()));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222", "GPNEQQQR"] });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, not_found: ["GPNEQQQR", "BBBB2222"] });
      expect(h.net.requests("GET", ITEMS)[1].url.searchParams.get("itemKey")).toBe("AAAARRRR,BBBB2222");
      expect(h.net.requests("DELETE", ITEMS)[1].url.searchParams.get("itemKey")).toBe("AAAARRRR");
    });

    it("DI-06d 412, nel frattempo sparite tutte → errore not_found, nessuna seconda DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, (req, hit) => zLibraryQuery(hit === 1 ? [article("AAAARRRR")] : [])(req, hit));
      h.net.on("DELETE", ITEMS, zError(412));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), "No items found");
      expect(json.status).toBe("not_found");
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(1);
    });

    it("DI-07 versione di libreria assente → errore strutturato, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, jsonResponse([zoteroEntity(article("AAAARRRR"))]));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), "Could not determine library version");
      expect(json.hint).toBe("Nothing was deleted. Retry the same call once.");
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
      expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), status);
    });

    it.each([403, 429, 500])("DI-11 HTTP %i sulla DELETE → isError", async (status) => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("DELETE", ITEMS, zError(status));
      expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), status);
    });

    it("DI-12 errore di rete → isError", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, networkError());
      expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }));
    });

    describe("validazione input", () => {
      it.each([
        ["item_keys", {}],
        ["item_keys", { item_keys: [] }],
        ["item_keys", { item_keys: "AAAARRRR" }],
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
