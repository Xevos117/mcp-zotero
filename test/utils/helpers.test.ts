import { describe, it, expect, vi, afterEach } from "vitest";
import { logger } from "../../src/utils/logger.js";
import { formatErrorResponse } from "../../src/utils/error-formatter.js";
import { extractPdfText } from "../../src/utils/pdf-text-extractor.js";
import { isZoteroApiError } from "../../src/types/zotero-types.js";
import { fetchWithRetry } from "../../src/utils/fetch-retry.js";
import { resolveDoi } from "../../src/utils/doi-resolver.js";
import { putFulltext } from "../../src/utils/zotero-fulltext.js";
import { FakeNet, jsonResponse, statusResponse, networkError } from "../helpers/fake-net.js";
import { createZoteroClient } from "../helpers/mcp-harness.js";
import { makePdf } from "../helpers/fixtures.js";
import { ZBASE, USER_ID, zError, zList, zWrite, article } from "../helpers/zotero-fake.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("logger", () => {
  it("H-01 scrive una riga JSON su stderr (mai su stdout, riservato al protocollo stdio)", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("hello", { tool: "x", n: 1 });
    logger.warn("careful");
    logger.error("boom", { status: 500 });
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(3);
    const lines = err.mock.calls.map((c) => String(c[0]));
    for (const l of lines) expect(l.endsWith("\n")).toBe(true);
    const [a, b, c] = lines.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ level: "info", message: "hello", tool: "x", n: 1 });
    expect(b).toMatchObject({ level: "warn", message: "careful" });
    expect(c).toMatchObject({ level: "error", message: "boom", status: 500 });
    expect(new Date(a.timestamp).toISOString()).toBe(a.timestamp);
  });
});

describe("formatErrorResponse", () => {
  it("H-02 contenuto testuale JSON {error, ...details} senza flag isError (comportamento attuale)", () => {
    const r = formatErrorResponse("Oops", { item_key: "K", nested: { a: 1 } });
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe("text");
    expect(JSON.parse(r.content[0].text)).toEqual({ error: "Oops", item_key: "K", nested: { a: 1 } });
    expect((r as Record<string, unknown>).isError).toBeUndefined();
  });

  it("H-03 una chiave 'error' nei details sovrascrive il messaggio (pin)", () => {
    const r = formatErrorResponse("Original", { error: "Override" });
    expect(JSON.parse(r.content[0].text).error).toBe("Override");
  });
});

describe("extractPdfText (unpdf reale)", () => {
  it("H-04 estrae testo e numero di pagine da un PDF reale", async () => {
    const r = await extractPdfText(makePdf("Grounded truth 123"));
    expect(r.text).toContain("Grounded truth 123");
    expect(r.totalPages).toBe(1);
  });

  it("H-05 rifiuta un buffer che non è un PDF", async () => {
    await expect(extractPdfText(Buffer.from("%PDF-1.4\nnot really"))).rejects.toBeDefined();
  });
});

describe("isZoteroApiError con errori reali di zotero-api-client", () => {
  it("H-06 un ErrorResponse (HTTP 403) è riconosciuto con lo status", async () => {
    const net = new FakeNet().install();
    net.on("GET", `${ZBASE}/items`, zError(403, "Forbidden"));
    const api = createZoteroClient();
    const err = await api.library("user", USER_ID).items().get().catch((e: unknown) => e);
    expect(isZoteroApiError(err)).toBe(true);
    expect((err as { response: { status: number } }).response.status).toBe(403);
  });

  it("H-07 un errore di rete non è un errore API Zotero", async () => {
    const net = new FakeNet().install();
    net.on("GET", `${ZBASE}/items`, networkError());
    const api = createZoteroClient();
    const err = await api.library("user", USER_ID).items().get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isZoteroApiError(err)).toBe(false);
  });
});

describe("contratto zotero-api-client usato dai tool", () => {
  it("H-08 getTotalResults/getVersion leggono Total-Results e Last-Modified-Version", async () => {
    const net = new FakeNet().install();
    net.on("GET", `${ZBASE}/items`, zList([article("AAAA1111")], { total: 77, version: 1234 }));
    const res = await createZoteroClient().library("user", USER_ID).items().get({ limit: 1 });
    expect(res.getTotalResults()).toBe(77);
    expect(res.getVersion()).toBe(1234);
    expect((res.getData() as Array<{ key: string }>)[0].key).toBe("AAAA1111");
  });

  it("H-09 scrittura multipla: getData restituisce TUTTI gli oggetti inviati, getErrors oggetti {code,message}", async () => {
    const net = new FakeNet().install();
    net.on("POST", `${ZBASE}/items`, zWrite({ keys: ["SKIP", "OK000001"], fail: { 0: { code: 400, message: "bad" } } }));
    const res = await createZoteroClient()
      .library("user", USER_ID)
      .items()
      .post([{ itemType: "book", title: "A" }, { itemType: "book", title: "B" }]);
    expect(res.isSuccess()).toBe(false);
    const data = res.getData();
    expect(data).toHaveLength(2); // non solo i successi: vedi BUG AI-09
    expect(data[0].key).toBeUndefined();
    expect(data[1].key).toBe("OK000001");
    expect(res.getErrors()).toEqual({ 0: expect.objectContaining({ code: 400, message: "bad" }) });
  });

  it("H-10 delete multipla: DELETE ?itemKey=A,B con If-Unmodified-Since-Version", async () => {
    const net = new FakeNet().install();
    net.on("DELETE", `${ZBASE}/items`, statusResponse(204, "", { "Last-Modified-Version": "9" }));
    await createZoteroClient().library("user", USER_ID).items().version(8).delete(["A", "B"]);
    const [req] = net.requests("DELETE", `${ZBASE}/items`);
    expect(req.url.searchParams.get("itemKey")).toBe("A,B");
    expect(req.headers.get("If-Unmodified-Since-Version")).toBe("8");
  });
});

describe("fetchWithRetry (casi non coperti)", () => {
  it("H-11 Retry-After come data HTTP nel passato → ritenta subito", async () => {
    const net = new FakeNet().install();
    net.on("GET", "x.example/r", (_req, hit) =>
      hit === 1 ? statusResponse(503, "", { "Retry-After": new Date(Date.now() - 60_000).toUTCString() }) : statusResponse(200, "ok")
    );
    const res = await fetchWithRetry("https://x.example/r");
    expect(res.status).toBe(200);
    expect(net.calls).toHaveLength(2);
  });

  it("H-12 status non ritentabile (500) restituito subito", async () => {
    const net = new FakeNet().install();
    net.on("GET", "x.example/r", statusResponse(500));
    const res = await fetchWithRetry("https://x.example/r");
    expect(res.status).toBe(500);
    expect(net.calls).toHaveLength(1);
  });

  it("H-13 dopo maxRetries restituisce l'ultima risposta 429", async () => {
    const net = new FakeNet().install();
    net.on("GET", "x.example/r", statusResponse(429, "", { "Retry-After": "0" }));
    const res = await fetchWithRetry("https://x.example/r", undefined, { maxRetries: 2 });
    expect(res.status).toBe(429);
    expect(net.calls).toHaveLength(3);
  });

  it("H-14 errore di rete propagato (nessun retry)", async () => {
    const net = new FakeNet().install();
    net.on("GET", "x.example/r", networkError("ECONNREFUSED"));
    await expect(fetchWithRetry("https://x.example/r")).rejects.toThrow("ECONNREFUSED");
    expect(net.calls).toHaveLength(1);
  });
});

describe("resolveDoi (fetch finto)", () => {
  it("H-15 codifica il DOI, chiede CSL-JSON e restituisce il JSON", async () => {
    const net = new FakeNet().install();
    net.on("GET", /^doi\.org\//, jsonResponse({ title: "T", type: "book" }));
    const data = await resolveDoi("10.1000/a b#c");
    expect(data).toEqual({ title: "T", type: "book" });
    const [req] = net.calls;
    expect(req.url.pathname).toBe("/10.1000%2Fa%20b%23c");
    expect(req.headers.get("Accept")).toBe("application/vnd.citationstyles.csl+json");
  });

  it("H-16 404 → errore che cita DOI e status", async () => {
    const net = new FakeNet().install();
    net.on("GET", /^doi\.org\//, statusResponse(404, "nope"));
    await expect(resolveDoi("10.1/x")).rejects.toThrow(/10\.1\/x.*404/);
  });
});

describe("putFulltext (fetch finto)", () => {
  it("H-17 PUT JSON con content/indexedPages/totalPages e API key; 204 → success", async () => {
    const net = new FakeNet().install();
    net.on("PUT", `${ZBASE}/items/ATT00001/fulltext`, statusResponse(204));
    const r = await putFulltext(USER_ID, "ATT00001", "k-123", "testo ü", 4);
    expect(r).toEqual({ success: true });
    const [req] = net.calls;
    expect(req.headers.get("Zotero-API-Key")).toBe("k-123");
    expect(req.json()).toEqual({ content: "testo ü", indexedPages: 4, totalPages: 4 });
  });

  it.each([
    [413, "413"],
    [500, "500"],
  ])("H-18 status %i → success=false con lo status nel messaggio", async (status, needle) => {
    const net = new FakeNet().install();
    net.on("PUT", `${ZBASE}/items/ATT00001/fulltext`, statusResponse(status));
    const r = await putFulltext(USER_ID, "ATT00001", "k", "t", 1);
    expect(r.success).toBe(false);
    expect(r.error).toContain(needle);
  });
});
