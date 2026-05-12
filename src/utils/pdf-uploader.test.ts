import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadAndUploadPdf } from "./pdf-uploader.js";
import { createZoteroApiMock } from "../__mocks__/zotero-api.mock.js";

vi.mock("./pdf-text-extractor.js", () => ({
  extractPdfText: vi.fn(),
}));

vi.mock("./zotero-fulltext.js", () => ({
  putFulltext: vi.fn(),
}));

const TEST_USER_ID = "12345";
const TEST_API_KEY = "test-api-key";
const pdfBuffer = Buffer.from("%PDF-1.4 fake-pdf-content");

function mockFetchChain(overrides?: {
  download?: Partial<Response>;
  auth?: Record<string, unknown>;
  upload?: Partial<Response>;
  register?: Partial<Response>;
}) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/pdf" }),
    arrayBuffer: () =>
      Promise.resolve(
        pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
      ),
    ...overrides?.download,
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve(
        overrides?.auth ?? {
          url: "https://storage.zotero.org/upload",
          contentType: "application/octet-stream",
          prefix: "PREFIX",
          suffix: "SUFFIX",
          uploadKey: "UPLOAD_KEY_123",
        }
      ),
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 201,
    ...overrides?.upload,
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 204,
    ...overrides?.register,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function mockFulltextSuccess() {
  const { extractPdfText } = await import("./pdf-text-extractor.js");
  const { putFulltext } = await import("./zotero-fulltext.js");
  vi.mocked(extractPdfText).mockResolvedValueOnce({ text: "Extracted PDF text", totalPages: 5 });
  vi.mocked(putFulltext).mockResolvedValueOnce({ success: true });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadAndUploadPdf", () => {
  it("successfully downloads and uploads a PDF", async () => {
    mockFetchChain();
    await mockFulltextSuccess();

    const writeData = {
      isSuccess: true,
      data: [{ key: "UP001", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(true);
    expect(result.itemKey).toBe("UP001");
    expect(result.filename).toBe("paper.pdf");
    expect(result.sizeBytes).toBe(pdfBuffer.length);
    expect(result.fulltextIndexed).toBe(true);
  });

  it("returns error when download fails (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    );

    const { mock } = createZoteroApiMock([]);
    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("network_error");
      expect(result.error.networkDetail).toBe("fetch failed");
    }
  });

  it("returns error when download returns non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 403 })
    );

    const { mock } = createZoteroApiMock([]);
    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/forbidden.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("download_failed");
      expect(result.error.status).toBe(403);
    }
  });

  it("returns error when upload authorization fails", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () =>
        Promise.resolve(
          pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
        ),
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });
    vi.stubGlobal("fetch", fetchMock);

    const writeData = {
      isSuccess: true,
      data: [{ key: "UP002", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("auth_failed");
      expect(result.error.status).toBe(403);
    }
  });

  it("skips upload when file already exists", async () => {
    const fetchMock = mockFetchChain({ auth: { exists: 1 } });
    await mockFulltextSuccess();

    const writeData = {
      isSuccess: true,
      data: [{ key: "UP003", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(true);
    expect(result.itemKey).toBe("UP003");
    // Only 2 fetch calls: download + auth (no binary upload or register)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles fulltext extraction failure gracefully", async () => {
    mockFetchChain();

    const { extractPdfText } = await import("./pdf-text-extractor.js");
    vi.mocked(extractPdfText).mockRejectedValueOnce(new Error("Corrupt PDF"));

    const writeData = {
      isSuccess: true,
      data: [{ key: "UP004", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/corrupt.pdf",
    });

    expect(result.success).toBe(true);
    expect(result.fulltextIndexed).toBe(false);
    expect(result.fulltextStatus).toContain("PDF text extraction failed");
  });

  it("creates child attachment with parentItem", async () => {
    mockFetchChain();
    await mockFulltextSuccess();

    const writeData = {
      isSuccess: true,
      data: [{ key: "UP005", title: "paper.pdf" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);

    await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
      parentItem: "PARENT1",
    });

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("parentItem", "PARENT1");
    expect(postedData[0]).toHaveProperty("collections", []);
  });

  it("returns error when server returns HTML instead of PDF", async () => {
    const htmlBuffer = Buffer.from("<!DOCTYPE html><html><body>Please use a browser</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/html" }),
        arrayBuffer: () =>
          Promise.resolve(
            htmlBuffer.buffer.slice(htmlBuffer.byteOffset, htmlBuffer.byteOffset + htmlBuffer.byteLength)
          ),
      })
    );

    const { mock } = createZoteroApiMock([]);
    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("not_pdf");
      expect(result.error.message).toContain("HTML page instead of a PDF");
      expect(result.error.detectedContentType).toBe("text/html");
    }
  });

  it("returns error when downloaded file is not a valid PDF", async () => {
    const randomBuffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/octet-stream" }),
        arrayBuffer: () =>
          Promise.resolve(
            randomBuffer.buffer.slice(randomBuffer.byteOffset, randomBuffer.byteOffset + randomBuffer.byteLength)
          ),
      })
    );

    const { mock } = createZoteroApiMock([]);
    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("not_pdf");
      expect(result.error.message).toContain("not a valid PDF");
      expect(result.error.message).toContain("missing %PDF- header");
    }
  });

  it("returns storage_quota_exceeded when auth returns 413", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () =>
        Promise.resolve(
          pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
        ),
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 413 });
    vi.stubGlobal("fetch", fetchMock);

    const writeData = {
      isSuccess: true,
      data: [{ key: "QUOTA1", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("storage_quota_exceeded");
      expect(result.error.status).toBe(413);
      expect(result.error.message).toContain("storage quota");
      expect(result.itemKey).toBe("QUOTA1");
    }
  });

  it("returns item_creation_failed with networkDetail when API throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/pdf" }),
        arrayBuffer: () =>
          Promise.resolve(
            pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
          ),
      })
    );

    const { mock, postStub } = createZoteroApiMock([]);
    postStub.mockRejectedValueOnce(new Error("Connection refused"));

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("item_creation_failed");
      expect(result.error.networkDetail).toBe("Connection refused");
    }
  });

  it("returns auth_failed with networkDetail when auth fetch throws", async () => {
    const fetchMock = vi.fn();
    // download succeeds
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      arrayBuffer: () =>
        Promise.resolve(
          pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
        ),
    });
    // auth fetch throws network error
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);

    const writeData = {
      isSuccess: true,
      data: [{ key: "AUTH_NET", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    const result = await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("auth_failed");
      expect(result.error.networkDetail).toBe("Failed to fetch");
      expect(result.itemKey).toBe("AUTH_NET");
    }
  });

  it("sends User-Agent header in download request", async () => {
    const fetchMock = mockFetchChain();
    await mockFulltextSuccess();

    const writeData = {
      isSuccess: true,
      data: [{ key: "UP006", title: "paper.pdf" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    await downloadAndUploadPdf(mock, "user", TEST_USER_ID, TEST_API_KEY, {
      url: "https://example.com/paper.pdf",
    });

    // First fetch call is the download
    const downloadCall = fetchMock.mock.calls[0];
    expect(downloadCall[1]).toHaveProperty("headers");
    const headers = downloadCall[1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("mcp-zotero/1.0 (Open Access PDF retrieval)");
  });
});
