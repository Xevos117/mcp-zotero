import { FakeNet, FakeRequest, binaryResponse, jsonResponse, statusResponse, networkError } from "./fake-net.js";
import { ZBASE, ZOTERO_HOST, USER_ID } from "./zotero-fake.js";
import { makePdf } from "./fixtures.js";

/**
 * Route per il flusso completo di upload file Zotero usato da
 * import_pdf_to_zotero, add_items_by_doi e find_and_attach_pdfs:
 * auth (POST /items/K/file) → upload su storage → register (upload=KEY) →
 * PUT /items/K/fulltext.
 */

export const UPLOAD_HOST = "zoterofilestorage.s3.amazonaws.com";
export const UPLOAD_KEY = "UPLOADKEY123";
const fileRoute = (base: string) => new RegExp(`^${base.replace(/\./g, "\\.")}/items/[A-Z0-9]+/file$`);
const fulltextRoute = (base: string) => new RegExp(`^${base.replace(/\./g, "\\.")}/items/[A-Z0-9]+/fulltext$`);
export const FILE_ROUTE = fileRoute(ZBASE);
export const FULLTEXT_ROUTE = fulltextRoute(ZBASE);

export interface PipelineOptions {
  /** Status della richiesta di autorizzazione (default 200). */
  authStatus?: number | "network";
  /** Se true l'auth risponde `{exists: 1}` (file già presente). */
  exists?: boolean;
  uploadStatus?: number | "network";
  registerStatus?: number | "network";
  fulltextStatus?: number;
  /** Base host+path della libreria (default ZBASE, libreria utente). */
  base?: string;
}

export function installUploadPipeline(net: FakeNet, opts: PipelineOptions = {}): void {
  const base = opts.base ?? ZBASE;
  net.on("POST", fileRoute(base), (req: FakeRequest) => {
    const form = req.form();
    if (form.has("upload")) {
      if (opts.registerStatus === "network") return networkError("register reset")(req, 0);
      return statusResponse(opts.registerStatus ?? 204);
    }
    if (opts.authStatus === "network") return networkError("auth reset")(req, 0);
    const status = opts.authStatus ?? 200;
    if (status !== 200) return statusResponse(status, "File would exceed quota");
    if (opts.exists) return jsonResponse({ exists: 1 });
    return jsonResponse({
      url: `https://${UPLOAD_HOST}/`,
      contentType: "multipart/form-data; boundary=----zotero",
      prefix: "------zotero\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\n",
      suffix: "\r\n------zotero--",
      uploadKey: UPLOAD_KEY,
    });
  });
  net.on("POST", `${UPLOAD_HOST}/`, (req) => {
    if (opts.uploadStatus === "network") return networkError("upload reset")(req, 0);
    return statusResponse(opts.uploadStatus ?? 201);
  });
  net.on("PUT", fulltextRoute(base), statusResponse(opts.fulltextStatus ?? 204));
}

/** Route che serve un PDF (o altro contenuto) a un URL dato. */
export function servePdf(net: FakeNet, url: string, body: Buffer = makePdf("Open access paper"), contentType = "application/pdf"): void {
  const u = new URL(url);
  net.on("GET", `${u.host}${u.pathname}`, () => binaryResponse(body, contentType));
}

/** Chiave d'item dall'URL /users/U/items/KEY/(file|fulltext). */
export function itemKeyOf(req: FakeRequest): string {
  const parts = req.url.pathname.split("/");
  return parts[parts.indexOf("items") + 1];
}

// ─── Unpaywall ──────────────────────────────────────────────────

export const UNPAYWALL_HOST = "api.unpaywall.org";
export const UNPAYWALL_EMAIL = "tester@example.org";

export type UnpaywallFixture = Record<string, unknown> | number | "network";

export function oaGold(pdfUrl: string, extraLocations: string[] = []) {
  const best = { url_for_pdf: pdfUrl, url: pdfUrl, host_type: "publisher", license: "cc-by", version: "publishedVersion" };
  return {
    is_oa: true,
    oa_status: "gold",
    best_oa_location: best,
    oa_locations: [best, ...extraLocations.map((u) => ({ ...best, url_for_pdf: u, url: u, host_type: "repository" }))],
  };
}

export function oaGreenLandingOnly(landing: string) {
  const best = { url_for_pdf: null, url: landing, host_type: "repository", license: null, version: "acceptedVersion" };
  return { is_oa: true, oa_status: "green", best_oa_location: best, oa_locations: [best] };
}

/** Come 10.1371/journal.pmed.0020124 dal vivo: best_oa_location senza PDF, PDF in una location successiva. */
export function oaPdfInLaterLocation(landing: string, pdfUrl: string) {
  const best = { url_for_pdf: null, url: landing, host_type: "publisher", license: "cc-by", version: "publishedVersion" };
  const repo = { url_for_pdf: pdfUrl, url: landing, host_type: "repository", license: "cc-by", version: "publishedVersion" };
  return { is_oa: true, oa_status: "gold", best_oa_location: best, oa_locations: [best, repo] };
}

export const CLOSED = { is_oa: false, oa_status: "closed", best_oa_location: null, oa_locations: [] };

/** Route Unpaywall: risposta per DOI (JSON, status HTTP o errore di rete); default closed. */
export function installUnpaywall(net: FakeNet, byDoi: Record<string, UnpaywallFixture>): void {
  net.on("GET", new RegExp(`^${UNPAYWALL_HOST.replace(/\./g, "\\.")}/v2/`), (req) => {
    const doi = decodeURIComponent(req.url.pathname.replace(/^\/v2\//, ""));
    const fx = byDoi[doi] ?? CLOSED;
    if (fx === "network") return networkError("unpaywall down")(req, 0);
    if (typeof fx === "number") return statusResponse(fx, "error");
    return jsonResponse({ doi, ...fx });
  });
}

export { ZOTERO_HOST, USER_ID };

/** Campi del risultato della pipeline condivisa (src/utils/oa-pdf.ts) che non dipendono dal tool chiamante. */
const SHARED_PDF_FIELDS = [
  "status",
  "reason",
  "source",
  "url_used",
  "filename",
  "size_bytes",
  "fulltext_indexed",
  "landing_url",
  "oa_status",
  "failed_urls",
] as const;

export function sharedPdfFields(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(SHARED_PDF_FIELDS.filter((f) => f in result).map((f) => [f, result[f]]));
}

/** Stesso scenario eseguito direttamente sulla pipeline condivisa, per confrontarlo con l'output dei tool. */
export async function runSharedPipeline(doi: string, itemKey = "DIRECT01"): Promise<Record<string, unknown>> {
  const { attachOpenAccessPdf } = await import("../../src/utils/oa-pdf.js");
  const { createZoteroClient, TEST_API_KEY } = await import("./mcp-harness.js");
  const result = await attachOpenAccessPdf(
    { itemKey, doi },
    { zoteroApi: createZoteroClient(), library: { type: "user", id: USER_ID }, apiKey: TEST_API_KEY }
  );
  return result as unknown as Record<string, unknown>;
}
