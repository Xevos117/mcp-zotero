import { describe, it, expect, afterEach } from "vitest";
import { Harness, startHarness, expectValidationError } from "../helpers/mcp-harness.js";
import { FakeHandler, jsonResponse, statusResponse, networkError } from "../helpers/fake-net.js";
import { ZBASE, zLibraryQuery, zList, zCollectionNotFound, article } from "../helpers/zotero-fake.js";

const ITEMS = `${ZBASE}/items`;
const COLL_ITEMS = `${ZBASE}/collections/CPLQQQQR/items`;
const CROSSREF = /^api\.crossref\.org\/works\//;

const RETRACTION = {
  type: "retraction",
  DOI: "10.1016/s0140-6736(10)60175-4",
  label: "Retraction",
  source: "retraction-watch",
  updated: { "date-time": "2010-02-06T00:00:00Z", "date-parts": [[2010, 2, 6]] },
};
const CORRECTION = { type: "correction", DOI: "10.1016/s0140-6736(04)15715-2", label: "Correction", source: "retraction-watch", updated: { "date-parts": [[2004, 3, 6]] } };
const CONCERN = { type: "expression_of_concern", DOI: "10.5555/eoc", label: "Expression of concern", source: "publisher", updated: { "date-parts": [[2020, 6, 2]] } };

/** Crossref /works/{doi}: per-DOI fixture — array of notices, 404, a status, or a network failure. */
function crossref(byDoi: Record<string, unknown[] | number | "network">): FakeHandler {
  return (req, hit) => {
    const doi = decodeURIComponent(req.url.pathname.replace(/^\/works\//, "")).toLowerCase();
    const fx = byDoi[doi];
    if (fx === undefined) return jsonResponse({ message: {} }); // no updated-by → ok
    if (fx === "network") return networkError("crossref unreachable")(req, hit);
    if (typeof fx === "number") return statusResponse(fx, "err");
    return jsonResponse({ message: { "updated-by": fx } });
  };
}

describe("check_retractions (CR)", () => {
  let h: Harness;
  afterEach(async () => h.close());

  it("CR-01 DOI ritirato → status retracted con la nota (tipo, data, source)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("AAAA2222", { title: "RETRACTED: Ileal-lymphoid…", DOI: "10.1016/S0140-6736(97)11096-0" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1016/s0140-6736(97)11096-0": [CORRECTION, RETRACTION] }));
    const out = await h.call("check_retractions", { item_keys: ["AAAA2222"] });
    expect(out.isError).toBe(false);
    expect(out.json.summary).toMatchObject({ checked: 1, retracted: 1 });
    expect(out.json.flagged_count).toBe(1);
    const item = out.json.items[0];
    expect(item).toMatchObject({ key: "AAAA2222", doi: "10.1016/s0140-6736(97)11096-0", status: "retracted" });
    expect(item.notices).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "retraction", source: "retraction-watch", date: "2010-02-06" })])
    );
    // DOI normalized to lowercase in the Crossref request
    expect(h.net.toHost("api.crossref.org")).toHaveLength(1);
  });

  it("CR-02 DOI normale → ok; nessun updated-by", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("BBBB3333", { DOI: "10.1038/s41586-023-06647-8" })]));
    h.net.on("GET", CROSSREF, crossref({}));
    const out = await h.call("check_retractions", { item_keys: ["BBBB3333"] });
    expect(out.json.items[0]).toMatchObject({ status: "ok", notices: [] });
    expect(out.json.summary).toMatchObject({ checked: 1, ok: 1 });
    expect(out.json.flagged_count).toBe(0);
  });

  it("CR-03 nessun DOI → no_doi, nessuna chiamata a Crossref", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("CCCC4444", { DOI: "", title: "No DOI" })]));
    h.net.on("GET", CROSSREF, () => statusResponse(500, "should not be called"));
    const out = await h.call("check_retractions", { item_keys: ["CCCC4444"] });
    expect(out.json.items[0]).toMatchObject({ status: "no_doi", doi: null });
    expect(h.net.toHost("api.crossref.org")).toHaveLength(0);
  });

  it("CR-04 DOI in Extra (tipo senza campo DOI) → risolto e controllato", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("DDDD5555", { itemType: "book", DOI: undefined, extra: "Some: thing\nDOI: 10.1016/S0140-6736(97)11096-0\nOther: x" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1016/s0140-6736(97)11096-0": [RETRACTION] }));
    const out = await h.call("check_retractions", { item_keys: ["DDDD5555"] });
    expect(out.json.items[0]).toMatchObject({ status: "retracted", doi: "10.1016/s0140-6736(97)11096-0" });
  });

  it("CR-05 DOI sconosciuto a Crossref (404) → not_in_crossref", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("EEEE6666", { DOI: "10.9999/nope" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.9999/nope": 404 }));
    const out = await h.call("check_retractions", { item_keys: ["EEEE6666"] });
    expect(out.json.items[0]).toMatchObject({ status: "not_in_crossref" });
  });

  it("CR-06 un lookup fallito non fa fallire gli altri (lookup_failed isolato)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("FFFF7777", { DOI: "10.1111/fail" }), article("GGGG8888", { DOI: "10.2222/ok" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1111/fail": "network", "10.2222/ok": [] }));
    const out = await h.call("check_retractions", { item_keys: ["FFFF7777", "GGGG8888"] });
    expect(out.isError).toBe(false);
    const byKey = Object.fromEntries(out.json.items.map((i: { key: string; status: string }) => [i.key, i.status]));
    expect(byKey).toEqual({ FFFF7777: "lookup_failed", GGGG8888: "ok" });
    expect(out.json.summary).toMatchObject({ checked: 2, lookup_failed: 1, ok: 1 });
  });

  it("CR-07 precedenza: EoC → expression_of_concern (senza ritiro)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("HHHH9999", { DOI: "10.3333/eoc" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.3333/eoc": [CONCERN, CORRECTION] }));
    const out = await h.call("check_retractions", { item_keys: ["HHHH9999"] });
    expect(out.json.items[0].status).toBe("expression_of_concern");
  });

  it("CR-08 esattamente uno tra item_keys e collection_key", async () => {
    h = await startHarness();
    const both = await h.call("check_retractions", { item_keys: ["AAAA2222"], collection_key: "CPLQQQQR" });
    expect(both.isError).toBe(true);
    const neither = await h.call("check_retractions", {});
    expect(neither.isError).toBe(true);
  });

  it("CR-09 collection_key: controlla gli item della collezione; 404 → errore", async () => {
    h = await startHarness();
    h.net.on("GET", COLL_ITEMS, zList([article("INCOLLAA", { DOI: "10.4444/ret" }), article("INCOLLBB", { DOI: "" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.4444/ret": [RETRACTION] }));
    const out = await h.call("check_retractions", { collection_key: "CPLQQQQR" });
    expect(out.json.summary).toMatchObject({ checked: 2, retracted: 1, no_doi: 1 });

    h.net.on("GET", `${ZBASE}/collections/ZZZZZZZZ/items`, () => zCollectionNotFound());
    const nf = await h.call("check_retractions", { collection_key: "ZZZZZZZZ" });
    expect(nf.isError).toBe(true);
  });

  it("CR-10 più di 50 item_keys → errore di validazione", async () => {
    h = await startHarness();
    // 51 distinct valid Zotero keys (alphabet without 0/1/O): "AAAAA" + three alphabet chars
    const A = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const keys = Array.from({ length: 51 }, (_, i) => "AAAAA" + A[Math.floor(i / A.length)] + A[i % A.length] + A[(i * 7) % A.length]);
    expectValidationError(await h.call("check_retractions", { item_keys: keys }), "item_keys");
  });

  it("CR-11 chiavi non trovate elencate in not_found", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("JJJJ2222", { DOI: "10.5555/ok" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.5555/ok": [] }));
    const out = await h.call("check_retractions", { item_keys: ["JJJJ2222", "KKKK3333"] });
    expect(out.json.not_found).toEqual(["KKKK3333"]);
    expect(out.json.summary.checked).toBe(1);
  });

  it("CR-12 DOI con prefisso dx.doi.org e maiuscole → normalizzato (minuscolo, senza prefisso) e controllato", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("LLLL2222", { DOI: "http://dx.doi.org/10.1371/JOURNAL.pone.0161231" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1371/journal.pone.0161231": [{ type: "correction", source: "retraction-watch", updated: { "date-parts": [[2017, 1, 1]] } }] }));
    const out = await h.call("check_retractions", { item_keys: ["LLLL2222"] });
    expect(out.json.items[0]).toMatchObject({ doi: "10.1371/journal.pone.0161231", status: "corrected" });
    // the request path carries the bare, lowercase DOI
    expect(decodeURIComponent(h.net.toHost("api.crossref.org")[0].url.pathname)).toBe("/works/10.1371/journal.pone.0161231");
  });

  it("CR-13 Crossref 5xx su una voce → lookup_failed (il resto riesce)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("MMMM2222", { DOI: "10.6666/err" }), article("NNNN3333", { DOI: "10.7777/ok" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.6666/err": 503, "10.7777/ok": [] }));
    const out = await h.call("check_retractions", { item_keys: ["MMMM2222", "NNNN3333"] });
    expect(out.isError).toBe(false);
    const byKey = Object.fromEntries(out.json.items.map((i: { key: string; status: string }) => [i.key, i.status]));
    expect(byKey).toEqual({ MMMM2222: "lookup_failed", NNNN3333: "ok" });
  });

  it("CR-14 una sola nota di correzione → corrected (non flagged)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("PPPP2222", { DOI: "10.8888/corr" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.8888/corr": [{ type: "erratum", label: "Erratum", source: "publisher", updated: { "date-parts": [[2019, 5, 1]] } }] }));
    const out = await h.call("check_retractions", { item_keys: ["PPPP2222"] });
    expect(out.json.items[0].status).toBe("corrected");
    expect(out.json.flagged_count).toBe(0);
  });

  it("CR-15 DOI che è esso stesso una nota (solo update-to, nessun updated-by) → ok", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("QQQQ2222", { DOI: "10.9999/notice" })]));
    // the notice work points at what it corrects via update-to; it is not itself retracted
    h.net.on("GET", CROSSREF, () => jsonResponse({ message: { "update-to": [{ DOI: "10.1/target", type: "retraction" }] } }));
    const out = await h.call("check_retractions", { item_keys: ["QQQQ2222"] });
    expect(out.json.items[0]).toMatchObject({ status: "ok", notices: [] });
  });

  it("CR-16 collezione vuota → risultato vuoto, non un errore", async () => {
    h = await startHarness();
    h.net.on("GET", COLL_ITEMS, zList([]));
    const out = await h.call("check_retractions", { collection_key: "CPLQQQQR" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("No items to check");
  });

  it("CR-17 esattamente 50 item_keys → accettato (nessun errore di validazione)", async () => {
    h = await startHarness();
    const A = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    const keys = Array.from({ length: 50 }, (_, i) => "AAAAA" + A[Math.floor(i / A.length)] + A[i % A.length] + A[(i * 7) % A.length]);
    h.net.on("GET", ITEMS, zLibraryQuery([article(keys[0], { DOI: "10.1234/ok" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1234/ok": [] }));
    const out = await h.call("check_retractions", { item_keys: keys });
    expect(out.isError).toBe(false);
    expect(out.json.summary.checked).toBe(1);
    expect(out.json.not_found).toHaveLength(49);
  });

  it("CR-18 removal / withdrawal / partial_retraction → tutti retracted e flagged", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([
      article("RMVL2222", { DOI: "10.1016/removal" }),
      article("WDRW3333", { DOI: "10.1038/withdrawal" }),
      article("PRTL4444", { DOI: "10.1371/partial" }),
    ]));
    h.net.on("GET", CROSSREF, crossref({
      "10.1016/removal": [{ type: "removal", source: "retraction-watch", updated: { "date-parts": [[2021, 1, 1]] } }],
      "10.1038/withdrawal": [{ type: "withdrawal", source: "publisher", updated: { "date-parts": [[2021, 2, 1]] } }],
      "10.1371/partial": [{ type: "partial_retraction", source: "retraction-watch", updated: { "date-parts": [[2021, 3, 1]] } }],
    }));
    const out = await h.call("check_retractions", { item_keys: ["RMVL2222", "WDRW3333", "PRTL4444"] });
    expect(out.json.items.every((i: { status: string }) => i.status === "retracted")).toBe(true);
    expect(out.json.summary).toMatchObject({ checked: 3, retracted: 3 });
    expect(out.json.flagged_count).toBe(3);
  });

  it("CR-19 tipo di avviso sconosciuto → almeno corrected, mai scartato in silenzio", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("UNKT2222", { DOI: "10.4444/newtype" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.4444/newtype": [{ type: "new_type", label: "Something New", source: "crossref", updated: { "date-parts": [[2022, 1, 1]] } }] }));
    const out = await h.call("check_retractions", { item_keys: ["UNKT2222"] });
    expect(out.json.items[0].status).toBe("corrected");
    expect(out.json.items[0].notices).toEqual([expect.objectContaining({ type: "new_type" })]);
  });

  it("CR-20 stesso DOI su più voci → una sola richiesta a Crossref (deduplicato)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([
      article("DUPA2222", { DOI: "10.5555/dup" }),
      article("DUPB3333", { DOI: "10.5555/DUP" }), // same DOI, different case
    ]));
    h.net.on("GET", CROSSREF, crossref({ "10.5555/dup": [RETRACTION] }));
    const out = await h.call("check_retractions", { item_keys: ["DUPA2222", "DUPB3333"] });
    expect(h.net.toHost("api.crossref.org")).toHaveLength(1); // one lookup for the shared DOI
    expect(out.json.items.map((i: { status: string }) => i.status)).toEqual(["retracted", "retracted"]);
  });

  it("CR-21 tetto di 200 DOI unici: truncated + next_start, poi start continua", async () => {
    h = await startHarness();
    const A = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
    // 205 items, each a distinct key (collection keys are not schema-validated) and a distinct valid DOI
    const items = Array.from({ length: 205 }, (_, i) => {
      const key = "C" + A[Math.floor(i / (A.length * A.length)) % A.length] + A[Math.floor(i / A.length) % A.length] + A[i % A.length] + "AAAA";
      return article(key, { DOI: `10.1000/${i}` });
    });
    h.net.on("GET", COLL_ITEMS, zList(items));
    h.net.on("GET", CROSSREF, crossref({})); // every DOI → ok
    const first = await h.call("check_retractions", { collection_key: "CPLQQQQR" });
    expect(first.json.truncated).toBe(true);
    expect(first.json.next_start).toBe(200);
    expect(first.json.summary.checked).toBe(200);
    const second = await h.call("check_retractions", { collection_key: "CPLQQQQR", start: first.json.next_start });
    expect(second.json.truncated).toBeUndefined();
    expect(second.json.summary.checked).toBe(5);
  });

  it("CR-22 Crossref 500 poi 200 → ritentato e risolto (ok)", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("RTRY2222", { DOI: "10.8888/retry" })]));
    let hits = 0;
    h.net.on("GET", CROSSREF, () => {
      hits++;
      return hits < 2 ? statusResponse(500, "err") : jsonResponse({ message: {} });
    });
    const out = await h.call("check_retractions", { item_keys: ["RTRY2222"] });
    expect(out.json.items[0].status).toBe("ok");
    expect(hits).toBeGreaterThan(1); // retried the 500
  });

  it("CR-23 UNPAYWALL_EMAIL non valida → nessun mailto; valida → mailto nella richiesta", async () => {
    h = await startHarness({ unpaywallEmail: "not-an-email" });
    h.net.on("GET", ITEMS, zLibraryQuery([article("MAILAAA2", { DOI: "10.1234/m" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1234/m": [] }));
    await h.call("check_retractions", { item_keys: ["MAILAAA2"] });
    expect(h.net.toHost("api.crossref.org")[0].url.searchParams.get("mailto")).toBeNull();
    await h.close();

    h = await startHarness({ unpaywallEmail: "me@example.org" });
    h.net.on("GET", ITEMS, zLibraryQuery([article("MAILAAA2", { DOI: "10.1234/m" })]));
    h.net.on("GET", CROSSREF, crossref({ "10.1234/m": [] }));
    await h.call("check_retractions", { item_keys: ["MAILAAA2"] });
    expect(h.net.toHost("api.crossref.org")[0].url.searchParams.get("mailto")).toBe("me@example.org");
  });

  it("CR-24 type Crossref con trattino (Expression-of-Concern) → normalizzato e classificato", async () => {
    h = await startHarness();
    h.net.on("GET", ITEMS, zLibraryQuery([article("HYPH2222", { DOI: "10.1234/hyphen" })]));
    // Crossref returns both expression_of_concern and expression-of-concern; also mixed case / spaces
    h.net.on("GET", CROSSREF, crossref({ "10.1234/hyphen": [{ type: "Expression-of-Concern", source: "publisher", updated: { "date-parts": [[2021, 1, 1]] } }] }));
    const out = await h.call("check_retractions", { item_keys: ["HYPH2222"] });
    expect(out.json.items[0].status).toBe("expression_of_concern");
    expect(out.json.items[0].notices[0].type).toBe("expression_of_concern"); // stored normalized
  });
});
