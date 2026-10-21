import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectToolError,
  expectApiError,
  ZOTERO_ERROR_STATUSES,
  expectEmptyResult,
} from "../helpers/mcp-harness.js";
import { networkError } from "../helpers/fake-net.js";
import { ZBASE, zList, zError, zLibraryQuery, collection, ZItem } from "../helpers/zotero-fake.js";

const COLLS = `${ZBASE}/collections`;

function manyCollections(n: number): ZItem[] {
  return Array.from({ length: n }, (_, i) => collection(`C${String(i).padStart(7, "0")}`, `Coll ${i}`));
}

describe("get_collections (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("GC-01 restituisce le collezioni come JSON; prima pagina limit=100 start=0", async () => {
    h.net.on("GET", COLLS, zList([collection("CPLQQQQR", "ML"), collection("COL00002", "NLP", { parentCollection: "CPLQQQQR" })]));
    const out = await h.call("get_collections", {});
    expect(out.isError).toBe(false);
    expect(out.json).toEqual([
      expect.objectContaining({ key: "CPLQQQQR", name: "ML", parentCollection: false }),
      expect.objectContaining({ key: "COL00002", name: "NLP", parentCollection: "CPLQQQQR" }),
    ]);
    const p = h.net.calls[0].url.searchParams;
    expect(p.get("limit")).toBe("100");
    expect(p.get("start") ?? "0").toBe("0"); // start=0 può essere omesso dal client
  });

  it("GC-02 paginazione: 250 collezioni → 3 richieste (start 0/100/200), tutte restituite", async () => {
    h.net.on("GET", COLLS, zLibraryQuery(manyCollections(250)));
    const out = await h.call("get_collections", {});
    expect(out.json).toHaveLength(250);
    expect(h.net.calls.map((c) => c.url.searchParams.get("start") ?? "0")).toEqual(["0", "100", "200"]);
  });

  it("GC-03 paginazione robusta: Total-Results gonfiato non causa loop infiniti", async () => {
    const all = manyCollections(150);
    h.net.on("GET", COLLS, (req) => {
      const start = Number(req.url.searchParams.get("start"));
      return zList(all.slice(start, start + 100), { total: 1000 });
    });
    const out = await h.call("get_collections", {});
    expect(out.json).toHaveLength(150);
    expect(h.net.calls.length).toBe(3); // 100 + 50 + pagina vuota
  });

  it("GC-04 senza header Total-Results si ferma alla prima pagina", async () => {
    h.net.on("GET", COLLS, zList(manyCollections(100), { total: null }));
    const out = await h.call("get_collections", {});
    expect(out.json).toHaveLength(100);
    expect(h.net.calls).toHaveLength(1);
  });

  it("GC-05 collezioni nel cestino escluse di default, incluse con include_trashed", async () => {
    const data = [collection("CPLQQQQR", "Live"), collection("COL00002", "Trashed", { deleted: true })];
    h.net.on("GET", COLLS, zList(data));
    const def = await h.call("get_collections", {});
    expect(def.json.map((c: ZItem) => c.key)).toEqual(["CPLQQQQR"]);
    const all = await h.call("get_collections", { include_trashed: true });
    expect(all.json.map((c: ZItem) => c.key)).toEqual(["CPLQQQQR", "COL00002"]);
  });

  it("GC-06 tutte nel cestino → risultato vuoto che suggerisce include_trashed", async () => {
    h.net.on("GET", COLLS, zList([collection("COL00002", "Trashed", { deleted: true })]));
    const json = expectEmptyResult(await h.call("get_collections", {}), "No collections found");
    expect(json.suggestion).toContain("include_trashed=true");
    expect(json.suggestion).toContain("create_collection");
  });

  it("GC-07 nessuna collezione → risultato vuoto con helpUrl", async () => {
    h.net.on("GET", COLLS, zList([]));
    const json = expectEmptyResult(await h.call("get_collections", {}), "No collections found");
    expect(json.helpUrl).toMatch(/^https:\/\/www\.zotero\.org\//);
    expect(json.suggestion).toMatch(/search_library.*create_collection/);
  });

  it("GC-08 nomi unicode preservati", async () => {
    h.net.on("GET", COLLS, zList([collection("CPLQQQQR", "Tesi — 研究 / Ελληνικά 📚")]));
    const out = await h.call("get_collections", {});
    expect(out.json[0].name).toBe("Tesi — 研究 / Ελληνικά 📚");
  });

  it("GC-09 rifiuta include_trashed non booleano", async () => {
    expectValidationError(await h.call("get_collections", { include_trashed: "yes" }), "include_trashed");
    expect(h.net.calls).toHaveLength(0);
  });

  it.each(ZOTERO_ERROR_STATUSES)("GC-10 HTTP %i → isError", async (status) => {
    h.net.on("GET", COLLS, zError(status));
    expectApiError(await h.call("get_collections", {}), status);
  });

  it("GC-11 errore sulla seconda pagina → isError (nessun risultato parziale)", async () => {
    h.net.on("GET", COLLS, (req) =>
      (req.url.searchParams.get("start") ?? "0") === "0" ? zList(manyCollections(100), { total: 150 }) : zError(500)
    );
    expectApiError(await h.call("get_collections", {}), 500);
  });

  it("GC-12 errore di rete → isError", async () => {
    h.net.on("GET", COLLS, networkError());
    expectApiError(await h.call("get_collections", {}));
  });
});
