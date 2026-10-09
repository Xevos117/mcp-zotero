import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  Harness,
  startHarness,
  expectValidationError,
  expectSoftError,
  carriesApiKey,
} from "../helpers/mcp-harness.js";
import { binaryResponse, networkError, statusResponse } from "../helpers/fake-net.js";
import { ZBASE, zWrite, zError } from "../helpers/zotero-fake.js";
import { makePdf } from "../helpers/fixtures.js";
import {
  installUploadPipeline,
  servePdf,
  FILE_ROUTE,
  FULLTEXT_ROUTE,
  UPLOAD_HOST,
  UPLOAD_KEY,
} from "../helpers/pdf-pipeline.js";

const ITEMS = `${ZBASE}/items`;
const PDF_URL = "https://journals.example.org/papers/attention.pdf";

describe("import_pdf_to_zotero (MCP)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("IP-01 flusso completo: download → item → auth → upload → register → fulltext", async () => {
    const pdf = makePdf("Attention is all you need");
    servePdf(h.net, PDF_URL, pdf);
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00001"] }));
    installUploadPipeline(h.net);

    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });

    expect(out.isError).toBe(false);
    expect(out.json).toEqual({
      item_key: "IMP00001",
      filename: "attention.pdf",
      title: "attention.pdf",
      url: PDF_URL,
      parent_item: null,
      size_bytes: expect.any(Number), // valore esatto: vedi IP-23
      link_mode: "imported_url",
      fulltext_indexed: true,
      fulltext_status: expect.stringContaining("indexed successfully"),
    });

    // download con User-Agent
    const dl = h.net.requests("GET", "journals.example.org/papers/attention.pdf")[0];
    expect(dl.headers.get("User-Agent")).toMatch(/mcp-zotero/);
    // item allegato
    expect(h.net.requests("POST", ITEMS)[0].json()).toEqual([
      {
        itemType: "attachment",
        linkMode: "imported_url",
        title: "attention.pdf",
        url: PDF_URL,
        contentType: "application/pdf",
        filename: "attention.pdf",
        tags: [],
        collections: [],
      },
    ]);
    // auth con md5/filesize corretti e If-None-Match
    const [auth, register] = h.net.requests("POST", FILE_ROUTE);
    expect(auth.url.pathname).toBe("/users/424242/items/IMP00001/file");
    expect(carriesApiKey(auth.headers)).toBe(true);
    expect(auth.headers.get("If-None-Match")).toBe("*");
    const form = auth.form();
    expect(form.get("md5")).toBe(createHash("md5").update(pdf).digest("hex"));
    expect(form.get("filesize")).toBe(String(pdf.length));
    expect(form.get("filename")).toBe("attention.pdf");
    // upload: prefix + file + suffix
    const up = h.net.requests("POST", `${UPLOAD_HOST}/`)[0];
    expect(up.body!.includes(pdf)).toBe(true);
    expect(up.headers.get("Content-Type")).toContain("multipart/form-data");
    // register
    expect(register.form().get("upload")).toBe(UPLOAD_KEY);
    // fulltext con il testo estratto
    const ft = h.net.requests("PUT", FULLTEXT_ROUTE)[0];
    expect(ft.url.pathname).toBe("/users/424242/items/IMP00001/fulltext");
    expect(ft.json()).toMatchObject({ content: expect.stringContaining("Attention is all you need"), totalPages: 1 });
  });

  it("IP-02 file già presente su storage ({exists:1}) → niente upload/register", async () => {
    servePdf(h.net, PDF_URL);
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00002"] }));
    installUploadPipeline(h.net, { exists: true });
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
    expect(out.json.item_key).toBe("IMP00002");
    expect(h.net.requests("POST", FILE_ROUTE)).toHaveLength(1);
    expect(h.net.toHost(UPLOAD_HOST)).toHaveLength(0);
  });

  it("IP-03 figlio di parent_item: parentItem impostato, collections forzate a [], tags", async () => {
    servePdf(h.net, PDF_URL);
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00003"] }));
    installUploadPipeline(h.net);
    const out = await h.call("import_pdf_to_zotero", {
      url: PDF_URL,
      parent_item: "PAR00001",
      collections: ["COL00001"],
      tags: ["oa"],
      title: "Publisher PDF",
      filename: "custom.pdf",
    });
    expect(out.json).toMatchObject({ parent_item: "PAR00001", title: "Publisher PDF", filename: "custom.pdf" });
    expect(h.net.requests("POST", ITEMS)[0].json()).toEqual([
      expect.objectContaining({
        parentItem: "PAR00001",
        collections: [],
        tags: [{ tag: "oa" }],
        title: "Publisher PDF",
        filename: "custom.pdf",
      }),
    ]);
  });

  it("IP-04 standalone: collections usate", async () => {
    servePdf(h.net, PDF_URL);
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00004"] }));
    installUploadPipeline(h.net);
    await h.call("import_pdf_to_zotero", { url: PDF_URL, collections: ["COL00001"] });
    expect(h.net.requests("POST", ITEMS)[0].json()).toEqual([expect.objectContaining({ collections: ["COL00001"] })]);
  });

  it("IP-05 filename dall'URL: percent-decoding unicode; fallback document.pdf senza estensione", async () => {
    const u1 = "https://repo.example.org/files/%C3%A9t%C3%A9%20%E7%A0%94%E7%A9%B6.pdf";
    const u2 = "https://repo.example.org/download/12345";
    servePdf(h.net, u1);
    servePdf(h.net, u2);
    h.net.on("POST", ITEMS, zWrite());
    installUploadPipeline(h.net);
    expect((await h.call("import_pdf_to_zotero", { url: u1 })).json.filename).toBe("été 研究.pdf");
    expect((await h.call("import_pdf_to_zotero", { url: u2 })).json.filename).toBe("document.pdf");
  });

  it("IP-06 content_type non PDF → fulltext saltato", async () => {
    const url = "https://data.example.org/table.csv";
    // deve comunque iniziare con %PDF- per passare la validazione dei magic bytes
    servePdf(h.net, url, makePdf("csv?"), "text/csv");
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00006"] }));
    installUploadPipeline(h.net);
    const out = await h.call("import_pdf_to_zotero", { url, content_type: "text/csv" });
    expect(out.json.fulltext_indexed).toBe(false);
    expect(out.json.fulltext_status).toContain("Non-PDF");
    expect(h.net.requests("PUT", FULLTEXT_ROUTE)).toHaveLength(0);
  });

  describe("errori di download", () => {
    it.each([403, 404, 500])("IP-07 download HTTP %i → errore morbido con status", async (status) => {
      h.net.on("GET", "journals.example.org/papers/attention.pdf", statusResponse(status));
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "Failed to download file");
      expect(json.status).toBe(status);
      expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
    });

    it("IP-08 errore di rete nel download → errore morbido con details e suggestion", async () => {
      h.net.on("GET", "journals.example.org/papers/attention.pdf", networkError("ECONNRESET"));
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "Network error downloading file");
      expect(json.details).toContain("ECONNRESET");
      expect(json.suggestion).toBeTypeOf("string");
    });

    it("IP-09 pagina HTML al posto del PDF → 'not a valid PDF', nessun item creato", async () => {
      h.net.on(
        "GET",
        "journals.example.org/papers/attention.pdf",
        binaryResponse(Buffer.from("<!DOCTYPE html><html><body>Login</body></html>"), "text/html")
      );
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "not a valid PDF");
      expect(json.details).toContain("HTML");
      expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
    });

    it("IP-10 file vuoto → 'not a valid PDF'", async () => {
      h.net.on("GET", "journals.example.org/papers/attention.pdf", binaryResponse(Buffer.alloc(0)));
      expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "not a valid PDF");
    });

    it("IP-11 file oltre 100 MB → 'File exceeds 100 MB limit', nessun item creato", async () => {
      const big = Buffer.alloc(100 * 1024 * 1024 + 1);
      big.write("%PDF-1.4\n");
      h.net.on("GET", "journals.example.org/papers/attention.pdf", binaryResponse(big));
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "100 MB");
      expect(json.size_bytes).toBe(big.length);
      expect(h.net.requests("POST", ITEMS)).toHaveLength(0);
    }, 30_000);
  });

  describe("errori Zotero", () => {
    it("IP-12 creazione item rifiutata (failed) → errore morbido 'import_pdf_to_zotero failed'", async () => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite({ fail: { 0: { code: 400, message: "Parent item not found" } } }));
      expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL, parent_item: "NOPE" }), "import_pdf_to_zotero failed");
      expect(h.net.requests("POST", FILE_ROUTE)).toHaveLength(0);
    });

    it.each([403, 404, 412, 429, 500, 503])("IP-13 HTTP %i sulla creazione item → errore morbido con details", async (status) => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zError(status));
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "import_pdf_to_zotero failed");
      expect(json.details).toContain(String(status));
    });

    it("IP-14 quota storage piena (413 in auth) → errore morbido con item_key orfano e nota", async () => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite({ keys: ["ORPHAN01"] }));
      installUploadPipeline(h.net, { authStatus: 413 });
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "storage quota exceeded");
      expect(json).toMatchObject({ status: 413, item_key: "ORPHAN01" });
      expect(json.suggestion).toContain("zotero.org/settings/storage");
      expect(json.note).toContain("delete_items");
      expect(h.net.toHost(UPLOAD_HOST)).toHaveLength(0);
    });

    it.each([403, 412, 500])("IP-15 auth HTTP %i → 'Upload authorization failed'", async (status) => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite());
      installUploadPipeline(h.net, { authStatus: status });
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "Upload authorization failed");
      expect(json.status).toBe(status);
    });

    it("IP-16 auth errore di rete → 'Upload authorization failed'", async () => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite());
      installUploadPipeline(h.net, { authStatus: "network" });
      expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "Upload authorization failed");
    });

    it("IP-17 upload su storage HTTP 500 → 'File upload failed', niente register", async () => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite());
      installUploadPipeline(h.net, { uploadStatus: 500 });
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "File upload failed");
      expect(json.status).toBe(500);
      expect(h.net.requests("POST", FILE_ROUTE)).toHaveLength(1);
    });

    it("IP-18 register HTTP 412 → 'Upload registration failed'", async () => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite());
      installUploadPipeline(h.net, { registerStatus: 412 });
      const json = expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "Upload registration failed");
      expect(json.status).toBe(412);
    });

    it("IP-19 PUT fulltext 413 → successo ma fulltext_indexed=false con motivo", async () => {
      servePdf(h.net, PDF_URL);
      h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00019"] }));
      installUploadPipeline(h.net, { fulltextStatus: 413 });
      const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
      expect(out.isError).toBe(false);
      expect(out.json.item_key).toBe("IMP00019");
      expect(out.json.fulltext_indexed).toBe(false);
      expect(out.json.fulltext_status).toContain("413");
    });

    it("IP-20 PDF non estraibile (magic bytes ok, contenuto corrotto) → successo, fulltext non indicizzato", async () => {
      servePdf(h.net, PDF_URL, Buffer.from("%PDF-1.4\ngarbage that is not a pdf"));
      h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00020"] }));
      installUploadPipeline(h.net);
      const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
      expect(out.json.item_key).toBe("IMP00020");
      expect(out.json.fulltext_indexed).toBe(false);
      expect(out.json.fulltext_status).toContain("extraction failed");
    });
  });

  // BUG: pdf-uploader.ts:371/377 legge `buffer.length` DOPO extractPdfText():
  // unpdf/pdf.js trasferisce (detach) l'ArrayBuffer sottostante, quindi
  // size_bytes risulta 0 ogni volta che l'estrazione del testo riesce.
  it.fails("IP-23 BUG size_bytes è la dimensione reale del PDF anche dopo l'estrazione del testo", async () => {
    const pdf = makePdf("size check");
    servePdf(h.net, PDF_URL, pdf);
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00023"] }));
    installUploadPipeline(h.net);
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL });
    expect(out.json.fulltext_indexed).toBe(true);
    expect(out.json.size_bytes).toBe(pdf.length);
  });

  it("IP-24 size_bytes corretto quando l'estrazione non avviene (content_type non PDF)", async () => {
    const pdf = makePdf("size check");
    servePdf(h.net, PDF_URL, pdf);
    h.net.on("POST", ITEMS, zWrite({ keys: ["IMP00024"] }));
    installUploadPipeline(h.net);
    const out = await h.call("import_pdf_to_zotero", { url: PDF_URL, content_type: "application/octet-stream" });
    expect(out.json.size_bytes).toBe(pdf.length);
  });

  it("IP-21 ZOTERO_API_KEY assente → errore morbido senza rete", async () => {
    await h.close();
    h = await startHarness({ envApiKey: "" });
    expectSoftError(await h.call("import_pdf_to_zotero", { url: PDF_URL }), "ZOTERO_API_KEY");
    expect(h.net.calls).toHaveLength(0);
  });

  describe("validazione input", () => {
    it.each([
      ["url", {}],
      ["url", { url: "ftp//bad" }],
      ["tags", { url: PDF_URL, tags: "x" }],
      ["collections", { url: PDF_URL, collections: [1] }],
      ["content_type", { url: PDF_URL, content_type: 5 }],
    ])("IP-22 rifiuta %s non valido (%j)", async (field, args) => {
      expectValidationError(await h.call("import_pdf_to_zotero", args), field);
      expect(h.net.calls).toHaveLength(0);
    });
  });
});
