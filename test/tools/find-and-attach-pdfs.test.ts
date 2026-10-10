import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectEmptyResult,
} from "../helpers/mcp-harness.js";
import { networkError, statusResponse } from "../helpers/fake-net.js";
import { makePdf } from "../helpers/fixtures.js";
import {
  ZBASE,
  zList,
  zWrite,
  zError,
  zLibraryQuery,
  article,
  pdfAttachment,
  manyArticles,
  ZItem,
} from "../helpers/zotero-fake.js";
import {
  installUploadPipeline,
  installUnpaywall,
  servePdf,
  oaGold,
  oaGreenLandingOnly,
  oaPdfInLaterLocation,
  CLOSED,
  UNPAYWALL_EMAIL,
  UNPAYWALL_HOST,
  FILE_ROUTE,
} from "../helpers/pdf-pipeline.js";

const ITEMS = `${ZBASE}/items`;
const CHILDREN = new RegExp(`^${ZBASE.replace(/\./g, "\\.")}/items/[A-Z0-9]+/children$`);

type Result = { item_key: string; status: string; reason?: string; pdf_url?: string; landing_url?: string; oa_status?: string; source?: string };
const byKey = (json: { results: Result[] }) => Object.fromEntries(json.results.map((r) => [r.item_key, r]));

/** Libreria + children vuoti + POST allegati. */
function library(h: Harness, items: ZItem[], children: Record<string, ZItem[]> = {}) {
  h.net.on("GET", ITEMS, zLibraryQuery(items));
  h.net.on("GET", CHILDREN, (req) => {
    const key = req.url.pathname.split("/")[4];
    return zList(children[key] ?? []);
  });
  h.net.on("POST", ITEMS, zWrite());
}

describe("find_and_attach_pdfs (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness({ unpaywallEmail: UNPAYWALL_EMAIL });
  });
  afterEach(async () => {
    await h.close();
  });

  it("FA-01 item_keys: trova OA, scarica e allega; riepilogo conteggi", async () => {
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, { "10.1000/aaaa1111": oaGold("https://oa.example.org/a.pdf") });
    servePdf(h.net, "https://oa.example.org/a.pdf");
    installUploadPipeline(h.net);

    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.isError).toBe(false);
    expect(out.json).toMatchObject({ processed: 1, attached: 1, not_found: 0, skipped: 0, errors: 0, quota_exceeded: 0, dry_run: false });
    expect(out.json.results).toEqual([
      { item_key: "AAAA1111", doi: "10.1000/aaaa1111", status: "attached", source: "unpaywall_gold", pdf_url: "https://oa.example.org/a.pdf" },
    ]);
    expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("itemKey")).toBe("AAAA1111");
    const attach = h.net.requests("POST", ITEMS)[0].json<Array<Record<string, unknown>>>()[0];
    expect(attach).toMatchObject({ itemType: "attachment", parentItem: "AAAA1111" });
  });

  it("FA-26 PDF solo in una oa_location successiva (PLOS): allegato, filename dal DOI", async () => {
    const plosPdf = "https://journals.plos.org/plosmedicine/article/file?id=10.1000/aaaa1111&type=printable";
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, { "10.1000/aaaa1111": oaPdfInLaterLocation("https://doi.org/10.1000/aaaa1111", plosPdf) });
    servePdf(h.net, plosPdf);
    installUploadPipeline(h.net);

    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results).toEqual([
      { item_key: "AAAA1111", doi: "10.1000/aaaa1111", status: "attached", source: "unpaywall_green", pdf_url: plosPdf },
    ]);
    const attach = h.net.requests("POST", ITEMS)[0].json<Array<Record<string, unknown>>>()[0];
    expect(attach).toMatchObject({ filename: "10.1000_aaaa1111.pdf", title: "10.1000_aaaa1111.pdf" });
  });

  it("FA-27 URL senza .pdf con Content-Disposition: filename dall'header", async () => {
    const url = "https://repo.example.org/bitstream/handle/123?download=1";
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, { "10.1000/aaaa1111": oaGold(url) });
    h.net.on("GET", "repo.example.org/bitstream/handle/123", () =>
      new Response(new Uint8Array(makePdf("cd")), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Lovelace 1843.pdf"' },
      })
    );
    installUploadPipeline(h.net);

    await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    const attach = h.net.requests("POST", ITEMS)[0].json<Array<Record<string, unknown>>>()[0];
    expect(attach.filename).toBe("Lovelace 1843.pdf");
  });

  it("FA-28 solo landing page dell'editore: il motivo nomina l'editore, non un repository", async () => {
    library(h, [article("AAAA1111")]);
    const landing = "https://publisher.example.org/article/1";
    const fx = oaPdfInLaterLocation(landing, "unused");
    installUnpaywall(h.net, { "10.1000/aaaa1111": { ...fx, oa_locations: [fx.best_oa_location] } });

    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(byKey(out.json).AAAA1111).toMatchObject({ status: "not_found", landing_url: landing });
    expect(byKey(out.json).AAAA1111.reason).toContain("on the publisher's site");
  });

  it("FA-02 item_keys e collection_key insieme → errore strutturato, nessuna rete", async () => {
    expectErrorJson(await h.call("find_and_attach_pdfs", { item_keys: ["A"], collection_key: "C" }), "not both");
    expect(h.net.calls).toHaveLength(0);
  });

  it("FA-03 né item_keys né collection_key → errore strutturato", async () => {
    expectErrorJson(await h.call("find_and_attach_pdfs", {}), "Provide either item_keys or collection_key");
    expect(h.net.calls).toHaveLength(0);
  });

  it("FA-04 item_keys vuoto → risultato vuoto 'No items to process'", async () => {
    expectEmptyResult(await h.call("find_and_attach_pdfs", { item_keys: [] }), "No items to process");
  });

  it("FA-05 collection_key: pagina la collezione (Total-Results) ed esclude allegati e note", async () => {
    const articles = manyArticles(20, "C");
    const coll = [...articles, pdfAttachment("ATTX0001", "C0000000"), { key: "NOTEX001", itemType: "note" }];
    // 2 pagine lato collezione: 15 + 7 (Total-Results 22)
    h.net.on("GET", `${ZBASE}/collections/COL00001/items`, (req) => {
      const start = Number(req.url.searchParams.get("start") ?? 0);
      return zList(coll.slice(start, start === 0 ? 15 : 22), { total: coll.length });
    });
    library(h, articles);
    installUnpaywall(h.net, {});
    const out = await h.call("find_and_attach_pdfs", { collection_key: "COL00001", skip_if_attachment_exists: false });
    expect(out.json.processed).toBe(20);
    expect(out.json.not_found).toBe(20);
    expect(h.net.requests("GET", `${ZBASE}/collections/COL00001/items`)).toHaveLength(2);
    expect(h.net.requests("GET", ITEMS)[0].url.searchParams.get("itemKey")!.split(",")).toHaveLength(20);
  });

  // Ex bug di main: la GET metadati inviava le 120 chiavi in un solo itemKey e l'API ne
  // restituisce al massimo 100 per pagina → 20 item finivano in "Item not found".
  it("FA-25 collection_key con 120 item: tutti processati", async () => {
    const articles = manyArticles(120, "C");
    h.net.on("GET", `${ZBASE}/collections/COL00001/items`, zLibraryQuery(articles));
    library(h, articles);
    installUnpaywall(h.net, {});
    const out = await h.call("find_and_attach_pdfs", { collection_key: "COL00001", skip_if_attachment_exists: false });
    expect(out.json.processed).toBe(120);
    expect(out.json.not_found).toBe(120);
  });

  it("FA-06 collezione vuota → risultato vuoto 'No items to process'", async () => {
    h.net.on("GET", `${ZBASE}/collections/COL00001/items`, zList([]));
    expectEmptyResult(await h.call("find_and_attach_pdfs", { collection_key: "COL00001" }), "No items to process");
  });

  it("FA-07 item senza DOI → status error 'No DOI'; chiave inesistente → 'Item not found'", async () => {
    library(h, [article("NODOI001", { DOI: undefined })]);
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["NODOI001", "GHOST001"] });
    const r = byKey(out.json);
    expect(r.NODOI001).toMatchObject({ status: "error", reason: "No DOI" });
    expect(r.GHOST001).toMatchObject({ status: "error", reason: "Item not found" });
    expect(out.json.errors).toBe(2);
    expect(h.net.toHost(UNPAYWALL_HOST)).toHaveLength(0);
  });

  it("FA-08 skip_if_attachment_exists (default) con PDF figlio → skipped, nessun lookup", async () => {
    library(h, [article("AAAA1111")], { AAAA1111: [pdfAttachment("ATT00001", "AAAA1111")] });
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results[0]).toMatchObject({ status: "skipped" });
    expect(out.json.skipped).toBe(1);
    expect(h.net.toHost(UNPAYWALL_HOST)).toHaveLength(0);
  });

  it("FA-09 figlio non PDF (snapshot HTML) non conta come allegato esistente", async () => {
    library(h, [article("AAAA1111")], { AAAA1111: [pdfAttachment("SNAP0001", "AAAA1111", { contentType: "text/html" })] });
    installUnpaywall(h.net, {});
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results[0].status).toBe("not_found");
  });

  it("FA-10 skip_if_attachment_exists=false → nessuna richiesta children", async () => {
    library(h, [article("AAAA1111")], { AAAA1111: [pdfAttachment("ATT00001", "AAAA1111")] });
    installUnpaywall(h.net, {});
    await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"], skip_if_attachment_exists: false });
    expect(h.net.requests("GET", CHILDREN)).toHaveLength(0);
  });

  it("FA-11 dry_run → status 'available' con pdf_url, nessun download/upload", async () => {
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, { "10.1000/aaaa1111": oaGold("https://oa.example.org/a.pdf") });
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"], dry_run: true });
    expect(out.json.dry_run).toBe(true);
    expect(out.json.results[0]).toMatchObject({ status: "available", pdf_url: "https://oa.example.org/a.pdf", source: "unpaywall_gold" });
    expect(h.net.toHost("oa.example.org")).toHaveLength(0);
    expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
  });

  it("FA-12 Unpaywall: closed → 'OA status: closed'; green solo landing → landing_url", async () => {
    library(h, [article("AAAA1111"), article("BBBB2222")]);
    installUnpaywall(h.net, {
      "10.1000/aaaa1111": CLOSED,
      "10.1000/bbbb2222": oaGreenLandingOnly("https://repo.example.org/h/2"),
    });
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111", "BBBB2222"] });
    const r = byKey(out.json);
    expect(r.AAAA1111).toMatchObject({ status: "not_found", reason: "OA status: closed", oa_status: "closed" });
    expect(r.BBBB2222).toMatchObject({ status: "not_found", landing_url: "https://repo.example.org/h/2", oa_status: "green" });
    expect(out.json.not_found).toBe(2);
  });

  it.each([404, 500, "network"] as const)("FA-13 Unpaywall %s → not_found 'No open access PDF found'", async (fx) => {
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, { "10.1000/aaaa1111": fx });
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results[0]).toMatchObject({ status: "not_found", reason: "No open access PDF found" });
  });

  it("FA-14 UNPAYWALL_EMAIL non valida → not_found con il warning di configurazione", async () => {
    await h.close();
    h = await startHarness({ unpaywallEmail: "not-an-email" });
    library(h, [article("AAAA1111")]);
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results[0]).toMatchObject({ status: "not_found", reason: expect.stringContaining("UNPAYWALL_EMAIL") });
    expect(h.net.toHost(UNPAYWALL_HOST)).toHaveLength(0);
  });

  it("FA-15 download primario fallito → prova l'URL di fallback e allega", async () => {
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, {
      "10.1000/aaaa1111": oaGold("https://publisher.example.org/blocked.pdf", ["https://repo.example.org/copy.pdf"]),
    });
    h.net.on("GET", "publisher.example.org/blocked.pdf", statusResponse(403));
    servePdf(h.net, "https://repo.example.org/copy.pdf");
    installUploadPipeline(h.net);
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results[0]).toMatchObject({ status: "attached", pdf_url: "https://repo.example.org/copy.pdf" });
  });

  it("FA-16 tutti gli URL falliscono → error 'Download failed for all 2 URL(s)'", async () => {
    library(h, [article("AAAA1111")]);
    installUnpaywall(h.net, {
      "10.1000/aaaa1111": oaGold("https://publisher.example.org/a.pdf", ["https://repo.example.org/b.pdf"]),
    });
    h.net.on("GET", "publisher.example.org/a.pdf", statusResponse(500));
    h.net.on("GET", "repo.example.org/b.pdf", networkError());
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] });
    expect(out.json.results[0]).toMatchObject({ status: "error", reason: "Download failed for all 2 URL(s)" });
  });

  it("FA-17 quota storage piena → quota_exceeded, warning, gli item non ancora avviati vengono saltati", async () => {
    const lib = manyArticles(12, "Q");
    library(h, lib);
    installUnpaywall(h.net, Object.fromEntries(lib.map((it, i) => [it.DOI as string, oaGold(`https://oa.example.org/${i}.pdf`)])));
    lib.forEach((_, i) => servePdf(h.net, `https://oa.example.org/${i}.pdf`));
    installUploadPipeline(h.net, { authStatus: 413 });
    const out = await h.call("find_and_attach_pdfs", { item_keys: lib.map((i) => i.key) });
    expect(out.isError).toBe(false);
    expect(out.json.processed).toBe(12);
    expect(out.json.quota_exceeded).toBeGreaterThanOrEqual(1);
    expect(out.json.storage_quota_warning).toContain("storage quota is full");
    expect(out.json.results.length).toBeLessThan(12);
    expect(h.net.requests("POST", FILE_ROUTE).length).toBeLessThan(12);
  });

  it("FA-18 errori della GET metadati Zotero → errore strutturato 'find_and_attach_pdfs failed'", async () => {
    for (const status of [403, 404, 429, 500, 503]) {
      await h.close();
      h = await startHarness({ unpaywallEmail: UNPAYWALL_EMAIL });
      h.net.on("GET", ITEMS, zError(status));
      const json = expectErrorJson(await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111"] }), "find_and_attach_pdfs failed");
      expect(json.details).toContain(String(status));
    }
  });

  it("FA-19 errore di rete sulla collezione → errore strutturato con details", async () => {
    h.net.on("GET", `${ZBASE}/collections/COL00001/items`, networkError("ETIMEDOUT"));
    const json = expectErrorJson(await h.call("find_and_attach_pdfs", { collection_key: "COL00001" }), "find_and_attach_pdfs failed");
    expect(json.details).toContain("ETIMEDOUT");
  });

  // BUG: find-and-attach-pdfs.ts:208 scarta i risultati "rejected" di
  // mapWithConcurrency: se la GET children di un item fallisce, l'item sparisce
  // da `results` e da tutti i contatori pur essendo contato in `processed`.
  it("FA-20 errore sui children di un item: l'item compare in results con status 'error'", async () => {
    library(h, [article("AAAA1111"), article("BBBB2222")]);
    h.net.on("GET", `${ZBASE}/items/BBBB2222/children`, zError(500));
    installUnpaywall(h.net, {});
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111", "BBBB2222"] });
    expect(out.json.results.map((r: Result) => r.item_key).sort()).toEqual(["AAAA1111", "BBBB2222"]);
    expect(byKey(out.json).BBBB2222.status).toBe("error");
    expect(byKey(out.json).BBBB2222.reason).toContain("500");
    expect(out.json.errors).toBeGreaterThanOrEqual(1);
    expect(out.json.results).toHaveLength(out.json.processed);
  });

  it("FA-21 errore sui children di un item: gli altri item vengono comunque processati", async () => {
    library(h, [article("AAAA1111"), article("BBBB2222")]);
    h.net.on("GET", `${ZBASE}/items/BBBB2222/children`, zError(500));
    installUnpaywall(h.net, {});
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["AAAA1111", "BBBB2222"] });
    expect(out.isError).toBe(false);
    expect(byKey(out.json).AAAA1111.status).toBe("not_found");
  });

  // Ex bug di main: oltre 100 item_keys quelli oltre il 100° risultavano "Item not found"
  // (pagina massima dell'API per itemKey).
  it("FA-22 120 item_keys: nessuno risulta 'Item not found'", async () => {
    const lib = manyArticles(120);
    library(h, lib);
    installUnpaywall(h.net, {});
    const out = await h.call("find_and_attach_pdfs", { item_keys: lib.map((i) => i.key), skip_if_attachment_exists: false });
    expect(out.json.results.filter((r: Result) => r.reason === "Item not found")).toHaveLength(0);
  });

  it("FA-23 ZOTERO_API_KEY assente → errore strutturato senza rete", async () => {
    await h.close();
    h = await startHarness({ unpaywallEmail: UNPAYWALL_EMAIL, envApiKey: "" });
    expectErrorJson(await h.call("find_and_attach_pdfs", { item_keys: ["A"] }), "ZOTERO_API_KEY");
    expect(h.net.calls).toHaveLength(0);
  });

  describe("validazione input", () => {
    it.each([
      ["item_keys", { item_keys: "AAAA1111" }],
      ["collection_key", { collection_key: 5 }],
      ["dry_run", { item_keys: ["A"], dry_run: "yes" }],
      ["skip_if_attachment_exists", { item_keys: ["A"], skip_if_attachment_exists: 1 }],
    ])("FA-24 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("find_and_attach_pdfs", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });
});
