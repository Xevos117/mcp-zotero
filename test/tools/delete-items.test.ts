import { describe, it, expect, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectApiError,
} from "../helpers/mcp-harness.js";
import { networkError, jsonResponse } from "../helpers/fake-net.js";
import { ZBASE, zError, zDeleted, zWrite, zLibraryQuery, article, manyArticles, zoteroEntity } from "../helpers/zotero-fake.js";
import { UnsafeOperationsMode } from "../../src/utils/unsafe-operations.js";

const ITEMS = `${ZBASE}/items`;

function deletedKeys(h: Harness): string[] {
  return h.net
    .requests("DELETE", ITEMS)
    .flatMap((r) => (r.url.searchParams.get("itemKey") ?? "").split(",").filter(Boolean));
}
/** Objects of the trash write (POST), each { key, version, deleted: 1 }. */
function trashed(h: Harness): Array<Record<string, unknown>> {
  return h.net.requests("POST", ITEMS).flatMap((r) => r.json<Array<Record<string, unknown>>>());
}

describe("delete_items (MCP)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  describe("guard UNSAFE_OPERATIONS (lo stesso per cestino e permanente)", () => {
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
      expect(json.hint).toMatch(/^Do not try to get around this with other tools/);
      expect(json.hint).toContain("'items' (allows delete_items) or 'all' (also delete_collection)");
      expect(json.hint).toMatch(/server's settings: with the Claude Desktop extension, "Deletions allowed" .*UNSAFE_OPERATIONS in the env block .*claude_desktop_config\.json or \.mcp\.json.*restart the client/);
      expect(h.net.calls).toHaveLength(0);
    });

    it("DI-01b 'none' rifiuta anche il cestino (default) e il permanente, nessuna rete", async () => {
      h = await startHarness({ unsafeOps: "none" });
      expectErrorJson(await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: true }), "Deletion of items is not allowed");
      expectErrorJson(await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: false }), "Deletion of items is not allowed");
      expect(h.net.calls).toHaveLength(0);
    });

    it.each<UnsafeOperationsMode>(["items", "all"])("DI-02 modalità '%s' → consentito (cestino di default)", async (mode) => {
      h = await startHarness({ unsafeOps: mode });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")], 88));
      h.net.on("POST", ITEMS, zWrite());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR"] });
      expect(out.isError).toBe(false);
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "trash" });
    });
  });

  describe("cestino (default): POST deleted:1", () => {
    it("DI-18 default → sposta nel cestino con una scrittura multi-oggetto (deleted:1) con la versione, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR"), article("BBBB2222")], 88));
      h.net.on("POST", ITEMS, zWrite());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"] });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR", "BBBB2222"], deleted_count: 2, mode: "trash" });
      const [post] = h.net.requests("POST", ITEMS);
      expect(post.headers.get("If-Unmodified-Since-Version")).toBe("88");
      expect(trashed(h)).toEqual([
        { key: "AAAARRRR", version: 88, deleted: 1 },
        { key: "BBBB2222", version: 88, deleted: 1 },
      ]);
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(0);
    });

    it("DI-19 cestino, cancellazione parziale: chiavi mancanti in not_found", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("POST", ITEMS, zWrite());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "GPNEQQQR"] });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "trash", not_found: ["GPNEQQQR"] });
    });

    it("DI-20 412 sul POST poi successo → nuova GET, secondo POST con la nuova versione", async () => {
      h = await startHarness({ unsafeOps: "items" });
      const lib = [article("AAAARRRR")];
      h.net.on("GET", ITEMS, (req, hit) => zLibraryQuery(lib, hit === 1 ? 88 : 89)(req, hit));
      h.net.on("POST", ITEMS, (_req, hit) => (hit === 1 ? zError(412) : zWrite()({ ..._req }, hit)));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR"] });
      expect(out.isError).toBe(false);
      expect(out.json).toMatchObject({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "trash" });
      expect(h.net.requests("GET", ITEMS)).toHaveLength(2);
      expect(h.net.requests("POST", ITEMS).map((p) => p.headers.get("If-Unmodified-Since-Version"))).toEqual(["88", "89"]);
    });

    it("DI-21 412 ripetuto sul POST → errore version_conflict, al massimo 2 POST", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("POST", ITEMS, zError(412));
      const json = expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), 412);
      expect(json.status).toBe("version_conflict");
      expect(h.net.requests("POST", ITEMS)).toHaveLength(2);
    });

    it("DI-22 il POST fallisce su tutte le voci → errore, nessuna cancellazione", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("POST", ITEMS, zWrite({ fail: { 0: { code: 500, message: "boom" } } }));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR"] });
      expectToolErrorMsg(out, "Could not move items to the trash");
    });

    it("DI-22b fallimento parziale del POST: l'indice 1 fallisce, lo 0 riesce → deleted_keys=[k0], failed=[k1]", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR"), article("BBBB2222")], 88));
      h.net.on("POST", ITEMS, zWrite({ fail: { 1: { code: 412, message: "conflict" } } }));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"] });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "trash", failed: ["BBBB2222"] });
    });

    it("DI-23 voce già nel cestino (deleted:1), senza permanent → already_in_trash, nessun POST", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR", { deleted: 1 })], 88));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR"] });
      expect(out.isError, out.text).toBe(false);
      expect(out.json).toMatchObject({ deleted_keys: [], deleted_count: 0, mode: "trash", already_in_trash: ["AAAARRRR"] });
      expect(out.json.hint).toMatch(/permanent: true to delete them for good/);
      expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
    });

    it("DI-24 mista: una viva e una già nel cestino → cestina solo la viva, l'altra in already_in_trash", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR"), article("BBBB2222", { deleted: 1 })], 88));
      h.net.on("POST", ITEMS, zWrite());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"] });
      expect(out.json).toMatchObject({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "trash", already_in_trash: ["BBBB2222"] });
      expect(trashed(h)).toEqual([{ key: "AAAARRRR", version: 88, deleted: 1 }]);
    });

    it("DI-25 permanent raggiunge una voce già nel cestino → DELETE, mode permanent", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR", { deleted: 1 })], 88));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: true });
      expect(out.json).toMatchObject({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "permanent" });
      expect(deletedKeys(h)).toEqual(["AAAARRRR"]);
    });
  });

  // Comportamento reale della Web API (verificato il 2026-10-11): se nessuna chiave di itemKey ha la forma
  // valida ("zzzzzzzz", "ZZZZZZZ0") il filtro viene ignorato e torna la libreria intera.
  describe("chiavi malformate (bug di perdita dati fino alla 2.0.0)", () => {
    const LIBRARY = [article("KEEP2222"), article("KEEP3333"), article("KEEP4444")];
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

    it("DI-17 API che restituisce più voci di quelle chieste → spostata nel cestino solo la chiave richiesta", async () => {
      h = await startHarness({ unsafeOps: "items" });
      libraryIgnoringFilter(h);
      h.net.on("POST", ITEMS, zWrite());
      const out = await h.call("delete_items", { item_keys: ["KEEP2222"] });
      expect(out.json).toEqual({ deleted_keys: ["KEEP2222"], deleted_count: 1, mode: "trash" });
      expect(trashed(h).map((o) => o.key)).toEqual(["KEEP2222"]);
    });
  });

  describe("permanente (permanent: true): DELETE", () => {
    it("DI-03 GET itemKey poi DELETE ?itemKey con la versione di libreria", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR"), article("BBBB2222")], 88));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"], permanent: true });
      expect(out.json).toMatchObject({ deleted_keys: ["AAAARRRR", "BBBB2222"], deleted_count: 2, mode: "permanent" });
      expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("itemKey")).toBe("AAAARRRR,BBBB2222");
      const [del] = h.net.requests("DELETE", ITEMS);
      expect(del.headers.get("If-Unmodified-Since-Version")).toBe("88");
      expect(deletedKeys(h)).toEqual(["AAAARRRR", "BBBB2222"]);
      expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
    });

    it("DI-04 cancellazione parziale: chiavi mancanti in not_found", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "GPNEQQQR"], permanent: true });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "permanent", not_found: ["GPNEQQQR"] });
      expect(deletedKeys(h)).toEqual(["AAAARRRR"]);
    });

    it("DI-05 nessuna chiave trovata → errore strutturato not_found, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([]));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["GPNEQQQR"], permanent: true }), "No items found");
      expect(json.status).toBe("not_found");
      expect(json.hint).toMatch(/^Nothing was deleted: none of these keys exists.*search_library/);
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(0);
    });

    it("DI-06 412 ripetuto sulla DELETE → errore version_conflict, al massimo 2 DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("DELETE", ITEMS, zError(412));
      const json = expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: true }), 412);
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
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222"], permanent: true });
      expect(out.isError).toBe(false);
      expect(out.json).toMatchObject({ deleted_keys: ["AAAARRRR", "BBBB2222"], deleted_count: 2, mode: "permanent" });
      const dels = h.net.requests("DELETE", ITEMS);
      expect(dels.map((d) => d.headers.get("If-Unmodified-Since-Version"))).toEqual(["88", "89"]);
    });

    it("DI-06c 412, nel frattempo una chiave è sparita → seconda DELETE solo sulle rimaste", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, (req, hit) =>
        zLibraryQuery(hit === 1 ? [article("AAAARRRR"), article("BBBB2222")] : [article("AAAARRRR")], 88 + hit)(req, hit)
      );
      h.net.on("DELETE", ITEMS, (_req, hit) => (hit === 1 ? zError(412) : zDeleted()));
      const out = await h.call("delete_items", { item_keys: ["AAAARRRR", "BBBB2222", "GPNEQQQR"], permanent: true });
      expect(out.json).toEqual({ deleted_keys: ["AAAARRRR"], deleted_count: 1, mode: "permanent", not_found: ["GPNEQQQR", "BBBB2222"] });
      expect(h.net.requests("DELETE", ITEMS)[1].url.searchParams.get("itemKey")).toBe("AAAARRRR");
    });

    it("DI-06d 412, nel frattempo sparite tutte → errore not_found, nessuna seconda DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, (req, hit) => zLibraryQuery(hit === 1 ? [article("AAAARRRR")] : [])(req, hit));
      h.net.on("DELETE", ITEMS, zError(412));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: true }), "No items found");
      expect(json.status).toBe("not_found");
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(1);
    });

    it("DI-07 versione di libreria assente → errore strutturato, nessuna DELETE", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, jsonResponse([zoteroEntity(article("AAAARRRR"))]));
      const json = expectErrorJson(await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: true }), "Could not determine library version");
      expect(json.hint).toBe("Nothing was deleted. Retry the same call once.");
      expect(h.net.requests("DELETE", ITEMS)).toHaveLength(0);
    });

    it("DI-09 50 chiavi esistenti: tutte cancellate, GET di verifica con limit=50", async () => {
      h = await startHarness({ unsafeOps: "items" });
      const lib = manyArticles(50);
      h.net.on("GET", ITEMS, zLibraryQuery(lib));
      h.net.on("DELETE", ITEMS, zDeleted());
      const out = await h.call("delete_items", { item_keys: lib.map((i) => i.key), permanent: true });
      expect(out.json.not_found).toBeUndefined();
      expect(deletedKeys(h)).toHaveLength(50);
      expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("limit")).toBe("50");
    });

    it.each([403, 429, 500])("DI-11 HTTP %i sulla DELETE → isError", async (status) => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zLibraryQuery([article("AAAARRRR")]));
      h.net.on("DELETE", ITEMS, zError(status));
      expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"], permanent: true }), status);
    });
  });

  describe("errori condivisi e validazione", () => {
    it.each([403, 404, 429, 500, 503])("DI-10 HTTP %i sulla GET → isError", async (status) => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, zError(status));
      expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }), status);
    });

    it("DI-12 errore di rete → isError", async () => {
      h = await startHarness({ unsafeOps: "items" });
      h.net.on("GET", ITEMS, networkError());
      expectApiError(await h.call("delete_items", { item_keys: ["AAAARRRR"] }));
    });

    it.each([
      ["item_keys", {}],
      ["item_keys", { item_keys: [] }],
      ["item_keys", { item_keys: "AAAARRRR" }],
      ["item_keys", { item_keys: manyArticles(51).map((i) => i.key) }],
      ["permanent", { item_keys: ["AAAARRRR"], permanent: "yes" }],
    ])("DI-13 rifiuta %s non valido", async (field, args) => {
      h = await startHarness({ unsafeOps: "items" });
      expectValidationError(await h.call("delete_items", args), field);
      expect(h.net.calls).toHaveLength(0);
    });

    it("DI-15 la validazione precede il guard", async () => {
      h = await startHarness({ unsafeOps: "none" });
      expectValidationError(await h.call("delete_items", { item_keys: [] }), "item_keys");
    });
  });
});

function expectToolErrorMsg(out: { isError?: boolean; text?: string }, msg: string) {
  expect(out.isError).toBe(true);
  expect(out.text).toContain(msg);
}
