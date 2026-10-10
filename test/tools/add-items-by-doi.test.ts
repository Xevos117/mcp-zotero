import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectErrorJson,
  expectToolError,
} from "../helpers/mcp-harness.js";
import { FakeHandler, jsonResponse, networkError, statusResponse } from "../helpers/fake-net.js";
import { ZBASE, zWrite, zError } from "../helpers/zotero-fake.js";
import {
  installUploadPipeline,
  installUnpaywall,
  servePdf,
  oaGold,
  oaGreenLandingOnly,
  CLOSED,
  UNPAYWALL_EMAIL,
  UNPAYWALL_HOST,
  FILE_ROUTE,
  itemKeyOf,
} from "../helpers/pdf-pipeline.js";

const ITEMS = `${ZBASE}/items`;
const DOI_ROUTE = /^doi\.org\/.+/;

function csl(doi: string, extra: Record<string, unknown> = {}) {
  return {
    type: "article-journal",
    DOI: doi,
    title: `Paper ${doi}`,
    author: [{ family: "Vaswani", given: "Ashish" }],
    issued: { "date-parts": [[2017, 6, 12]] },
    "container-title": "NeurIPS",
    ...extra,
  };
}

/** doi.org: CSL per i DOI noti, 404 per gli altri (o status/errore per DOI). */
function doiResolver(known: Record<string, Record<string, unknown> | number | "network">): FakeHandler {
  return (req) => {
    const doi = decodeURIComponent(req.url.pathname.slice(1));
    const fx = known[doi];
    if (fx === undefined) return statusResponse(404, "DOI Not Found");
    if (fx === "network") return networkError("doi.org unreachable")(req, 0);
    if (typeof fx === "number") return statusResponse(fx, "err");
    return jsonResponse(fx, { headers: { "Content-Type": "application/vnd.citationstyles.csl+json" } });
  };
}

/** POST /items: chiavi PAPER00x per gli item, ATTACH0x per gli allegati. */
function itemsAndAttachments(fail: Record<number, { code: number; message: string }> = {}): FakeHandler {
  let paper = 0;
  let attach = 0;
  return (req, hit) => {
    const body = req.json<Array<{ itemType: string }>>();
    const keys = body.map((b) => (b.itemType === "attachment" ? `ATTACH${String(attach++).padStart(2, "0")}` : `PAPER${String(paper++).padStart(3, "0")}`));
    return zWrite({ keys, fail })(req, hit);
  };
}

describe("add_items_by_doi (MCP)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  describe("senza Unpaywall (UNPAYWALL_EMAIL non impostata)", () => {
    beforeEach(async () => {
      h = await startHarness();
    });

    it("AID-01 risolve il DOI via content negotiation e crea l'item convertito", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.48550/arXiv.1706.03762": csl("10.48550/arXiv.1706.03762", { title: "Attention Is All You Need" }) }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.48550/arXiv.1706.03762"] });

      expect(out.isError).toBe(false);
      expect(out.json.success).toEqual([
        { doi: "10.48550/arXiv.1706.03762", item_key: "PAPER000", title: "Attention Is All You Need" },
      ]);
      expect(out.json.failed).toEqual([]);
      const [doiReq] = h.net.toHost("doi.org");
      expect(doiReq.headers.get("Accept")).toBe("application/vnd.citationstyles.csl+json");
      expect(decodeURIComponent(doiReq.url.pathname.slice(1))).toBe("10.48550/arXiv.1706.03762");
      const body = h.net.requests("POST", ITEMS)[0].json<Array<Record<string, unknown>>>();
      expect(body[0]).toMatchObject({
        itemType: "journalArticle",
        title: "Attention Is All You Need",
        DOI: "10.48550/arXiv.1706.03762",
        publicationTitle: "NeurIPS",
        creators: [{ creatorType: "author", firstName: "Ashish", lastName: "Vaswani" }],
      });
    });

    it("AID-02 senza email Unpaywall: pdf_results riporta il warning, nessuna chiamata a Unpaywall", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.json.pdf_results).toEqual([
        expect.objectContaining({ item_key: "PAPER000", pdf_attached: false, error: expect.stringContaining("UNPAYWALL_EMAIL") }),
      ]);
      expect(h.net.toHost(UNPAYWALL_HOST)).toHaveLength(0);
    });

    it("AID-03 auto_attach_pdf=false: nessun pdf_results", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"], auto_attach_pdf: false });
      expect(out.json).not.toHaveProperty("pdf_results");
    });

    it("AID-04 collection_key e tags finiscono nel payload", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      await h.call("add_items_by_doi", { dois: ["10.1/a"], collection_key: "COL00001", tags: ["llm"], auto_attach_pdf: false });
      const body = h.net.requests("POST", ITEMS)[0].json<Array<Record<string, unknown>>>();
      expect(body[0].collections).toEqual(["COL00001"]);
      expect(body[0].tags).toEqual(expect.arrayContaining([{ tag: "llm" }]));
    });

    it("AID-05 DOI non trovato (404) su uno dei due: l'altro viene creato, il fallito è in failed", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/good": csl("10.1/good") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.1/good", "10.1/missing"], auto_attach_pdf: false });
      expect(out.json.success.map((s: { doi: string }) => s.doi)).toEqual(["10.1/good"]);
      expect(out.json.failed).toEqual([{ doi: "10.1/missing", error: expect.stringContaining("404") }]);
      expect(h.net.requests("POST", ITEMS)[0].json<unknown[]>()).toHaveLength(1);
    });

    it("AID-06 tutti i DOI falliscono → errore strutturato, nessuna POST", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/net": "network" }));
      const json = expectErrorJson(
        await h.call("add_items_by_doi", { dois: ["10.1/missing", "10.1/net"] }),
        "All DOI resolutions failed"
      );
      expect(json.failed.map((f: { doi: string }) => f.doi)).toEqual(["10.1/missing", "10.1/net"]);
      expect(json.failed[1].error).toContain("doi.org unreachable");
      expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
    });

    it("AID-07 doi.org 429 con Retry-After: 0 → ritenta e riesce", async () => {
      h.net.on("GET", DOI_ROUTE, (req, hit) =>
        hit === 1 ? statusResponse(429, "slow down", { "Retry-After": "0" }) : doiResolver({ "10.1/a": csl("10.1/a") })(req, hit)
      );
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"], auto_attach_pdf: false });
      expect(out.json.success).toHaveLength(1);
      expect(h.net.toHost("doi.org")).toHaveLength(2);
    });

    it("AID-08 doi.org 500 → DOI in failed (nessun retry)", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": 500, "10.1/b": csl("10.1/b") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a", "10.1/b"], auto_attach_pdf: false });
      expect(out.json.failed).toEqual([{ doi: "10.1/a", error: expect.stringContaining("500") }]);
      expect(h.net.toHost("doi.org")).toHaveLength(2);
    });

    it("AID-09 DOI con caratteri speciali/unicode codificati nell'URL e titolo unicode preservato", async () => {
      const doi = "10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0";
      h.net.on("GET", DOI_ROUTE, doiResolver({ [doi]: csl(doi, { title: "Ånalyse — 分析 ✓" }) }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: [doi], auto_attach_pdf: false });
      expect(out.json.success[0]).toMatchObject({ doi, title: "Ånalyse — 分析 ✓" });
      expect(h.net.toHost("doi.org")[0].url.pathname).not.toContain("<");
    });

    it("AID-10 array vuoto → errore strutturato, nessuna rete", async () => {
      expectErrorJson(await h.call("add_items_by_doi", { dois: [] }), "At least one DOI is required");
      expect(h.net.calls).toHaveLength(0);
    });

    it("AID-11 scrittura Zotero rifiutata → errore strutturato 'Zotero API write failed' con indice", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments({ 0: { code: 400, message: "Invalid field" } }));
      const json = expectErrorJson(await h.call("add_items_by_doi", { dois: ["10.1/a"] }), "Zotero API write failed");
      expect(json.error).toContain("Item 0");
      expect(json.error).toContain("Invalid field");
    });

    // BUG: add-items-by-doi.ts:160 tratta un fallimento parziale come totale:
    // l'item creato con successo non viene riportato (resta orfano in libreria
    // e un nuovo tentativo crea duplicati).
    it("AID-12 scrittura parziale: riporta gli item creati e i falliti", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a"), "10.1/b": csl("10.1/b") }));
      h.net.on("POST", ITEMS, itemsAndAttachments({ 1: { code: 400, message: "Invalid field" } }));
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a", "10.1/b"], auto_attach_pdf: false });
      expect(out.isError).toBe(false); // successo parziale: non è un errore del tool
      expect(out.json.success).toEqual([expect.objectContaining({ doi: "10.1/a", item_key: "PAPER000" })]);
      expect(out.json.failed).toEqual([{ doi: "10.1/b", error: "400: Invalid field" }]);
    });

    it("AID-12b 60 DOI: scrittura in batch da 50, ordine e DOI preservati", async () => {
      const dois = Array.from({ length: 60 }, (_, i) => `10.8/${i}`);
      h.net.on("GET", DOI_ROUTE, doiResolver(Object.fromEntries(dois.map((d) => [d, csl(d)]))));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois, auto_attach_pdf: false });
      expect(h.net.requests("POST", ITEMS).map((r) => r.json<unknown[]>().length)).toEqual([50, 10]);
      expect(out.json.success.map((s: { doi: string }) => s.doi)).toEqual(dois);
      expect(new Set(out.json.success.map((s: { item_key: string }) => s.item_key)).size).toBe(60);
    });

    it.each([403, 404, 412, 413, 429, 500, 503])("AID-13 HTTP %i sulla POST Zotero → isError", async (status) => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, zError(status));
      expectToolError(await h.call("add_items_by_doi", { dois: ["10.1/a"] }), String(status));
    });

    it("AID-14 errore di rete sulla POST Zotero → isError", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, networkError());
      expectToolError(await h.call("add_items_by_doi", { dois: ["10.1/a"] }));
    });

    it("AID-15 batch di 10 DOI: risoluzione concorrente, una sola POST, ordine preservato", async () => {
      const dois = Array.from({ length: 10 }, (_, i) => `10.9/${i}`);
      h.net.on("GET", DOI_ROUTE, doiResolver(Object.fromEntries(dois.map((d) => [d, csl(d)]))));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois, auto_attach_pdf: false });
      expect(out.json.success.map((s: { doi: string }) => s.doi)).toEqual(dois);
      expect(h.net.requests("POST", ITEMS)).toHaveLength(1);
    });

    describe("validazione input", () => {
      it.each([
        ["dois", {}],
        ["dois", { dois: "10.1/a" }],
        ["dois", { dois: [10] }],
        ["auto_attach_pdf", { dois: ["10.1/a"], auto_attach_pdf: "true" }],
        ["tags", { dois: ["10.1/a"], tags: "x" }],
      ])("AID-16 rifiuta %s non valido (%j)", async (field, args) => {
        expectValidationError(await h.call("add_items_by_doi", args), field);
        expect(h.net.calls).toHaveLength(0);
      });
    });
  });

  describe("con Unpaywall", () => {
    beforeEach(async () => {
      h = await startHarness({ unpaywallEmail: UNPAYWALL_EMAIL });
    });

    it("AID-17 OA gold: scarica e allega il PDF (pdf_attached=true, source unpaywall_gold)", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": oaGold("https://oa.example.org/a.pdf") });
      servePdf(h.net, "https://oa.example.org/a.pdf");
      installUploadPipeline(h.net);

      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.json.pdf_results).toEqual([
        expect.objectContaining({ item_key: "PAPER000", doi: "10.1/a", pdf_attached: true, source: "unpaywall_gold" }),
      ]);
      expect(out.json).not.toHaveProperty("storage_quota_warning");
      const up = h.net.toHost(UNPAYWALL_HOST)[0];
      expect(up.url.searchParams.get("email")).toBe(UNPAYWALL_EMAIL);
      // allegato creato come figlio dell'item
      const attach = h.net.requests("POST", ITEMS)[1].json<Array<Record<string, unknown>>>()[0];
      expect(attach).toMatchObject({ itemType: "attachment", parentItem: "PAPER000", linkMode: "imported_url" });
    });

    it("AID-18 nessun OA (closed) → pdf_attached=false 'No open access PDF found'", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": CLOSED });
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.json.pdf_results[0]).toMatchObject({ pdf_attached: false, error: "No open access PDF found", oa_status: "closed" });
      expect(h.net.requests("POST", FILE_ROUTE)).toHaveLength(0);
    });

    it("AID-19 OA green solo landing page → landing_url e suggerimento import_pdf_to_zotero", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": oaGreenLandingOnly("https://repo.example.org/handle/1") });
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.json.pdf_results[0]).toMatchObject({
        pdf_attached: false,
        landing_url: "https://repo.example.org/handle/1",
        error: expect.stringContaining("import_pdf_to_zotero"),
      });
    });

    it.each([404, 500, "network"] as const)("AID-20 Unpaywall %s → nessun allegato, item comunque creati", async (fx) => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": fx });
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.isError).toBe(false);
      expect(out.json.success).toHaveLength(1);
      expect(out.json.pdf_results[0]).toMatchObject({ pdf_attached: false });
    });

    it("AID-21 quota storage piena (413) → storage_quota_warning, item creati", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": oaGold("https://oa.example.org/a.pdf") });
      servePdf(h.net, "https://oa.example.org/a.pdf");
      installUploadPipeline(h.net, { authStatus: 413 });
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.isError).toBe(false);
      expect(out.json.success).toHaveLength(1);
      expect(out.json.storage_quota_warning).toContain("storage quota is full");
      expect(out.json.pdf_results[0]).toMatchObject({ pdf_attached: false, error: expect.stringContaining("storage quota") });
    });

    it("AID-22 quota piena su batch grande: gli upload successivi vengono saltati", async () => {
      const dois = Array.from({ length: 12 }, (_, i) => `10.7/${i}`);
      h.net.on("GET", DOI_ROUTE, doiResolver(Object.fromEntries(dois.map((d) => [d, csl(d)]))));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, Object.fromEntries(dois.map((d, i) => [d, oaGold(`https://oa.example.org/${i}.pdf`)])));
      dois.forEach((_, i) => servePdf(h.net, `https://oa.example.org/${i}.pdf`));
      installUploadPipeline(h.net, { authStatus: 413 });
      const out = await h.call("add_items_by_doi", { dois });
      expect(out.json.success).toHaveLength(12);
      expect(out.json.storage_quota_warning).toBeDefined();
      expect(out.json.pdf_results.length).toBeLessThan(12);
      const authCalls = h.net.requests("POST", FILE_ROUTE).length;
      expect(authCalls).toBeLessThan(12);
    });

    it("AID-23 un PDF fallisce il download, l'altro si allega: risultati per item", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a"), "10.1/b": csl("10.1/b") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, {
        "10.1/a": oaGold("https://oa.example.org/a.pdf"),
        "10.1/b": oaGold("https://oa.example.org/missing.pdf"),
      });
      servePdf(h.net, "https://oa.example.org/a.pdf");
      h.net.on("GET", "oa.example.org/missing.pdf", statusResponse(404));
      installUploadPipeline(h.net);
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a", "10.1/b"] });
      const byDoi = Object.fromEntries(out.json.pdf_results.map((r: { doi: string }) => [r.doi, r]));
      expect(byDoi["10.1/a"].pdf_attached).toBe(true);
      expect(byDoi["10.1/b"]).toMatchObject({ pdf_attached: false, error: expect.stringContaining("404") });
      expect(h.net.requests("POST", FILE_ROUTE).map(itemKeyOf)).not.toContain("PAPER001");
    });

    it("AID-25 PDF primario 403: si prova il fallback, pdf_results riporta l'URL allegato", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": oaGold("https://oa.example.org/a.pdf", ["https://repo.example.org/a.pdf"]) });
      h.net.on("GET", "oa.example.org/a.pdf", statusResponse(403));
      servePdf(h.net, "https://repo.example.org/a.pdf");
      installUploadPipeline(h.net);

      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.json.pdf_results).toEqual([
        {
          item_key: "PAPER000",
          doi: "10.1/a",
          source: "unpaywall_gold",
          pdf_attached: true,
          pdf_url: "https://repo.example.org/a.pdf",
        },
      ]);
      // un solo allegato creato (auth + registrazione dell'upload): il download fallito non lascia item orfani
      expect([...new Set(h.net.requests("POST", FILE_ROUTE).map(itemKeyOf))]).toEqual(["ATTACH00"]);
    });

    it("AID-26 tutti gli URL falliscono: pdf_results elenca ogni URL con il suo errore", async () => {
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      installUnpaywall(h.net, { "10.1/a": oaGold("https://oa.example.org/a.pdf", ["https://repo.example.org/a.pdf"]) });
      h.net.on("GET", "oa.example.org/a.pdf", statusResponse(403));
      h.net.on("GET", "repo.example.org/a.pdf", statusResponse(404));
      installUploadPipeline(h.net);

      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.isError).toBe(false);
      expect(out.json.pdf_results[0]).toMatchObject({
        pdf_attached: false,
        error: "Download failed for all 2 URL(s)",
        failed_urls: [
          { url: "https://oa.example.org/a.pdf", error: expect.stringContaining("403") },
          { url: "https://repo.example.org/a.pdf", error: expect.stringContaining("404") },
        ],
      });
      expect(h.net.requests("POST", FILE_ROUTE)).toHaveLength(0);
    });

    it("AID-24 ZOTERO_API_KEY assente nell'ambiente → item creati, fase PDF saltata", async () => {
      await h.close();
      h = await startHarness({ unpaywallEmail: UNPAYWALL_EMAIL, envApiKey: "" });
      h.net.on("GET", DOI_ROUTE, doiResolver({ "10.1/a": csl("10.1/a") }));
      h.net.on("POST", ITEMS, itemsAndAttachments());
      const out = await h.call("add_items_by_doi", { dois: ["10.1/a"] });
      expect(out.json.success).toHaveLength(1);
      expect(out.json).not.toHaveProperty("pdf_results");
      expect(h.net.toHost(UNPAYWALL_HOST)).toHaveLength(0);
    });
  });
});
