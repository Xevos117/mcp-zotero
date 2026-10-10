import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { attachOpenAccessPdf, OaPdfOptions } from "../../src/utils/oa-pdf.js";
import { createCancellationToken } from "../../src/utils/concurrency.js";
import { createZoteroClient, TEST_API_KEY } from "../helpers/mcp-harness.js";
import { FakeNet, statusResponse } from "../helpers/fake-net.js";
import { ZBASE, USER_ID, zList, zWrite, pdfAttachment } from "../helpers/zotero-fake.js";
import {
  installUnpaywall,
  installUploadPipeline,
  servePdf,
  oaGold,
  oaGreenLandingOnly,
  UNPAYWALL_EMAIL,
  UNPAYWALL_HOST,
  FILE_ROUTE,
} from "../helpers/pdf-pipeline.js";

// Pipeline condivisa da add_items_by_doi e find_and_attach_pdfs: zotero-api-client reale, fetch finto.
const ITEMS = `${ZBASE}/items`;
const TARGET = { itemKey: "PARENT01", doi: "10.1000/parent01" };
const PRIMARY = "https://oa.example.org/a.pdf";
const FALLBACK = "https://repo.example.org/a.pdf";

describe("attachOpenAccessPdf (pipeline PDF open access condivisa)", () => {
  let net: FakeNet;
  let opts: OaPdfOptions;

  beforeEach(() => {
    vi.stubEnv("UNPAYWALL_EMAIL", UNPAYWALL_EMAIL);
    net = new FakeNet().install();
    net.on("POST", ITEMS, zWrite({ keys: ["ATT00001", "ATT00002"] }));
    installUploadPipeline(net);
    opts = { zoteroApi: createZoteroClient(), library: { type: "user", id: USER_ID }, apiKey: TEST_API_KEY };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("OA-01 primario 403 → fallback allegato con url_used, filename, size_bytes e fulltext", async () => {
    installUnpaywall(net, { [TARGET.doi]: oaGold(PRIMARY, [FALLBACK]) });
    net.on("GET", "oa.example.org/a.pdf", statusResponse(403));
    servePdf(net, FALLBACK);

    const r = await attachOpenAccessPdf(TARGET, opts);
    expect(r).toMatchObject({
      item_key: "PARENT01",
      status: "attached",
      url_used: FALLBACK,
      filename: "a.pdf",
      attachment_key: "ATT00001",
      fulltext_indexed: true,
    });
    expect(r.size_bytes).toBeGreaterThan(0);
    // il download fallito non crea allegati: una sola POST di item, figlia del padre
    expect(net.requests("POST", ITEMS)).toHaveLength(1);
    expect(net.requests("POST", ITEMS)[0].json<Array<Record<string, unknown>>>()[0]).toMatchObject({ parentItem: "PARENT01" });
  });

  it("OA-02 tutti gli URL falliscono → error con failed_urls nell'ordine provato", async () => {
    installUnpaywall(net, { [TARGET.doi]: oaGold(PRIMARY, [FALLBACK]) });
    net.on("GET", "oa.example.org/a.pdf", statusResponse(403));
    net.on("GET", "repo.example.org/a.pdf", statusResponse(404));

    const r = await attachOpenAccessPdf(TARGET, opts);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("Download failed for all 2 URL(s): oa.example.org 403, repo.example.org 404");
    expect(r.failed_urls?.map((f) => f.url)).toEqual([PRIMARY, FALLBACK]);
    expect(r.failed_urls?.map((f) => f.status)).toEqual([403, 404]);
    expect(r.failed_urls?.[0].error).toContain("403");
    expect(net.requests("POST", ITEMS)).toHaveLength(0);
  });

  it("OA-03 solo landing page → landing_page_only con landing_url, nessun download", async () => {
    installUnpaywall(net, { [TARGET.doi]: oaGreenLandingOnly("https://repo.example.org/h/1") });
    const r = await attachOpenAccessPdf(TARGET, opts);
    expect(r).toMatchObject({ status: "landing_page_only", landing_url: "https://repo.example.org/h/1", oa_status: "green" });
    expect(r.reason).toContain("at a repository");
    expect(net.requests("POST", ITEMS)).toHaveLength(0);
  });

  it("OA-04 PDF già presente con skipIfPdfExists → skipped senza interrogare Unpaywall", async () => {
    net.on("GET", `${ZBASE}/items/PARENT01/children`, zList([pdfAttachment("OLDPDF01", "PARENT01")]));
    installUnpaywall(net, { [TARGET.doi]: oaGold(PRIMARY) });
    const r = await attachOpenAccessPdf(TARGET, { ...opts, skipIfPdfExists: true });
    expect(r).toMatchObject({ status: "skipped", reason: "PDF attachment already exists" });
    expect(net.toHost(UNPAYWALL_HOST)).toHaveLength(0);
  });

  it("OA-05 contenuto non PDF (pagina HTML) → error, nessun allegato creato", async () => {
    installUnpaywall(net, { [TARGET.doi]: oaGold(PRIMARY) });
    servePdf(net, PRIMARY, Buffer.from("<!doctype html><html>login</html>"), "text/html");
    const r = await attachOpenAccessPdf(TARGET, opts);
    expect(r.status).toBe("error");
    expect(r.reason).toBe("Download failed for all 1 URL(s): oa.example.org not_pdf");
    expect(r.failed_urls?.[0]).not.toHaveProperty("status");
    expect(r.failed_urls?.[0].error).toContain("HTML page instead of a PDF");
    expect(net.requests("POST", ITEMS)).toHaveLength(0);
  });

  it("OA-06 quota storage piena → quota_exceeded, token di cancellazione impostato, fallback non provato", async () => {
    installUnpaywall(net, { [TARGET.doi]: oaGold(PRIMARY, [FALLBACK]) });
    servePdf(net, PRIMARY);
    servePdf(net, FALLBACK);
    installUploadPipeline(net, { authStatus: 413 });
    const cancel = createCancellationToken();
    const r = await attachOpenAccessPdf(TARGET, { ...opts, cancel });
    expect(r.status).toBe("quota_exceeded");
    expect(cancel.cancelled).toBe(true);
    expect(net.toHost("repo.example.org")).toHaveLength(0);
  });

  it("OA-07 dry run → available con url_used, nessun download", async () => {
    installUnpaywall(net, { [TARGET.doi]: oaGold(PRIMARY) });
    const r = await attachOpenAccessPdf(TARGET, { ...opts, dryRun: true });
    expect(r).toEqual({ item_key: "PARENT01", doi: TARGET.doi, status: "available", source: "unpaywall_gold", url_used: PRIMARY });
    expect(net.toHost("oa.example.org")).toHaveLength(0);
    expect(net.requests("POST", FILE_ROUTE)).toHaveLength(0);
  });
});
