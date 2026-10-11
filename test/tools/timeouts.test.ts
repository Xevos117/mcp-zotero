import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, startHarness } from "../helpers/mcp-harness.js";
import { hang, stalledBody, jsonResponse, statusResponse } from "../helpers/fake-net.js";
import { ZBASE, zSingle, zList, zWrite, article, pdfAttachment } from "../helpers/zotero-fake.js";
import { installUploadPipeline, servePdf, FILE_ROUTE, FULLTEXT_ROUTE, UPLOAD_HOST } from "../helpers/pdf-pipeline.js";
import { TIMEOUTS } from "../../src/utils/timeouts.js";

/**
 * Ogni chiamata di rete del prodotto ha un bound (src/utils/timeouts.ts). Qui i bound vengono abbassati a
 * 100 ms e un server della FakeNet resta fermo (hang) finché il signal del prodotto non abortisce: il tool
 * deve rispondere entro il bound con un errore che nomina l'operazione, invece di restare appeso.
 */

const PDF_URL = "https://journals.example.org/papers/slow.pdf";
const BOUND = "timed out after 0.1 s";

describe("timeout delle chiamate di rete (MCP)", () => {
  let h: Harness;
  const saved = { ...TIMEOUTS };
  beforeEach(async () => {
    Object.assign(TIMEOUTS, { zoteroApiMs: 100, metadataMs: 100, pdfTransferMs: 100 });
    h = await startHarness({ unpaywallEmail: "tester@example.org" });
  });
  afterEach(async () => {
    Object.assign(TIMEOUTS, saved);
    await h.close();
  });

  it("TO-01 Web API Zotero ferma (zotero-api-client) → isError che nomina la richiesta", async () => {
    h.net.on("GET", `${ZBASE}/items`, hang());
    const out = await h.call("search_library", { query: "x" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`Zotero API request (GET) ${BOUND} (api.zotero.org)`);
  });

  it("TO-02 download del PDF senza risposta → network_error con il timeout", async () => {
    h.net.on("GET", "journals.example.org/papers/slow.pdf", hang());
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`PDF download ${BOUND} (journals.example.org)`);
    expect(h.net.requests("POST", `${ZBASE}/items`)).toHaveLength(0);
  });

  it("TO-03 download che si blocca a metà corpo → network_error con il timeout", async () => {
    h.net.on("GET", "journals.example.org/papers/slow.pdf", stalledBody());
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`PDF download ${BOUND} (journals.example.org)`);
  });

  it.each([
    ["autorizzazione upload", "auth", "Upload authorization"],
    ["upload su storage", "upload", "File upload"],
    ["registrazione upload", "register", "Upload registration"],
  ])("TO-04 %s ferma → errore che nomina il passo", async (_label, step, operation) => {
    servePdf(h.net, PDF_URL);
    h.net.on("POST", `${ZBASE}/items`, zWrite({ keys: ["IMP00001"] }));
    installUploadPipeline(h.net); // l'ultima route registrata vince: gli override sotto
    if (step === "upload") h.net.on("POST", `${UPLOAD_HOST}/`, hang());
    if (step === "auth" || step === "register") {
      h.net.on("POST", FILE_ROUTE, (req, hit) => {
        const isRegister = req.form().has("upload");
        if ((step === "auth" && !isRegister) || (step === "register" && isRegister)) return hang()(req, hit);
        return isRegister
          ? statusResponse(204)
          : jsonResponse({ url: `https://${UPLOAD_HOST}/`, contentType: "multipart/form-data; boundary=x", prefix: "a", suffix: "b", uploadKey: "K" });
      });
    }
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`${operation} ${BOUND}`);
  });

  it("TO-05 PUT del fulltext fermo → import riuscito, fulltext non indicizzato con il motivo", async () => {
    servePdf(h.net, PDF_URL);
    h.net.on("POST", `${ZBASE}/items`, zWrite({ keys: ["IMP00001"] }));
    installUploadPipeline(h.net);
    h.net.on("PUT", FULLTEXT_ROUTE, hang());
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
    expect(out.isError).toBe(false);
    expect(out.json.fulltext_indexed).toBe(false);
    expect(out.json.fulltext_status).toContain(`Zotero fulltext upload ${BOUND}`);
  });

  it("TO-06 GET del fulltext fermo → isError che nomina la richiesta", async () => {
    h.net.on("GET", `${ZBASE}/items/PAR00001`, zSingle(article("PAR00001")));
    h.net.on("GET", `${ZBASE}/items/PAR00001/children`, zList([pdfAttachment("ATT00001", "PAR00001")]));
    h.net.on("GET", `${ZBASE}/items/ATT00001/fulltext`, hang());
    const out = await h.call("get_item_fulltext", { item_key: "PAR00001" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`Zotero fulltext request ${BOUND} (api.zotero.org)`);
  });

  it("TO-07 doi.org fermo → il DOI finisce tra i falliti con il timeout", async () => {
    h.net.on("GET", /^doi\.org\//, hang());
    const out = await h.call("add_items_by_doi", { dois: ["10.1/slow"], auto_attach_pdf: false });
    expect(out.isError).toBe(true);
    expect(out.json.failed[0].error).toContain(`DOI resolution ${BOUND} (doi.org)`);
  });

  it("TO-08 Unpaywall fermo → voce non trovata entro il bound, nessun download", async () => {
    h.net.on("GET", `${ZBASE}/items`, () => zList([article("DQIQQQQR", { DOI: "10.1/slow" })]) as Response);
    h.net.on("GET", `${ZBASE}/items/DQIQQQQR/children`, zList([]));
    h.net.on("GET", /^api\.unpaywall\.org\//, hang());
    const out = await h.call("find_and_attach_pdfs", { item_keys: ["DQIQQQQR"] });
    expect(out.isError).toBe(false);
    expect(out.json.results[0]).toMatchObject({ item_key: "DQIQQQQR", status: "not_found" });
  });
});
