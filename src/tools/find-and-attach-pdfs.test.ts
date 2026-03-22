import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { toolConfig } from "./find-and-attach-pdfs.js";
import { handleToolCall } from "./index.js";
import { createZoteroApiMock, fullItemFixture } from "../__mocks__/zotero-api.mock.js";

vi.mock("../utils/doi-resolver.js", () => ({
  resolveDois: vi.fn(),
}));

vi.mock("../citation-injector/injector.js", () => ({
  injectCitations: vi.fn(),
}));

vi.mock("../utils/pdf-text-extractor.js", () => ({
  extractPdfText: vi.fn(),
}));

vi.mock("../utils/zotero-fulltext.js", () => ({
  putFulltext: vi.fn(),
}));

vi.mock("../utils/unpaywall.js", () => ({
  lookupOaPdf: vi.fn(),
  lookupOaPdfWithFallbacks: vi.fn(),
}));

vi.mock("../utils/pdf-uploader.js", () => ({
  downloadAndUploadPdf: vi.fn(),
}));

const TEST_USER_ID = "12345";

const FindAndAttachPdfsSchema = z.object(toolConfig.inputSchema);

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// ─── Schema tests ───────────────────────────────────────────────

describe("FindAndAttachPdfsSchema", () => {
  it("accepts item_keys array", () => {
    const result = FindAndAttachPdfsSchema.parse({ item_keys: ["KEY1", "KEY2"] });
    expect(result.item_keys).toEqual(["KEY1", "KEY2"]);
  });

  it("accepts collection_key string", () => {
    const result = FindAndAttachPdfsSchema.parse({ collection_key: "COL001" });
    expect(result.collection_key).toBe("COL001");
  });

  it("defaults skip_if_attachment_exists to true", () => {
    const result = FindAndAttachPdfsSchema.parse({ item_keys: ["KEY1"] });
    expect(result.skip_if_attachment_exists).toBe(true);
  });

  it("defaults dry_run to false", () => {
    const result = FindAndAttachPdfsSchema.parse({ item_keys: ["KEY1"] });
    expect(result.dry_run).toBe(false);
  });

  it("accepts all optional params", () => {
    const result = FindAndAttachPdfsSchema.parse({
      item_keys: ["KEY1"],
      skip_if_attachment_exists: false,
      dry_run: true,
    });
    expect(result.skip_if_attachment_exists).toBe(false);
    expect(result.dry_run).toBe(true);
  });
});

// ─── Handler tests ──────────────────────────────────────────────

describe("find_and_attach_pdfs handler", () => {
  it("returns error when both item_keys and collection_key provided", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["KEY1"], collection_key: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Provide either item_keys or collection_key, not both");
  });

  it("returns error when neither item_keys nor collection_key provided", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "find_and_attach_pdfs",
      {},
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Provide either item_keys or collection_key");
  });

  it("attaches PDF when OA is found", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: true,
        pdf_url: "https://journal.org/article.pdf",
        source: "unpaywall_gold",
        license: "cc-by",
        oa_status: "gold",
      },
      fallback_urls: [],
    });

    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: true,
      itemKey: "ATT001",
      filename: "article.pdf",
      sizeBytes: 1024,
      fulltextIndexed: true,
      fulltextStatus: "Fulltext indexed successfully.",
    });

    const itemWithDoi = { ...fullItemFixture, DOI: "10.1234/test" };
    const { mock, getStub } = createZoteroApiMock([]);
    // Batch metadata fetch
    getStub.mockResolvedValueOnce({ getData: () => [itemWithDoi] });
    // Children check (skip_if_attachment_exists=true by default)
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ABC12345"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.attached).toBe(1);
    expect(parsed.results[0].status).toBe("attached");
    expect(parsed.results[0].source).toBe("unpaywall_gold");
  });

  it("returns error status for items without DOI", async () => {
    const itemNoDoi = { key: "NO_DOI", itemType: "book" };
    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [itemNoDoi] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["NO_DOI"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.errors).toBe(1);
    expect(parsed.results[0].status).toBe("error");
    expect(parsed.results[0].reason).toBe("No DOI");
  });

  it("skips items with existing PDF attachment when skip_if_attachment_exists is true", async () => {
    const itemWithDoi = { ...fullItemFixture, DOI: "10.1234/test" };
    const pdfChild = {
      key: "ATT001",
      itemType: "attachment",
      contentType: "application/pdf",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [itemWithDoi] });
    getStub.mockResolvedValueOnce({ getData: () => [pdfChild] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ABC12345"], skip_if_attachment_exists: true },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skipped).toBe(1);
    expect(parsed.results[0].status).toBe("skipped");
    expect(parsed.results[0].reason).toContain("already exists");
  });

  it("reports available PDFs in dry_run mode without downloading", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: true,
        pdf_url: "https://journal.org/article.pdf",
        source: "unpaywall_gold",
        license: "cc-by",
        oa_status: "gold",
      },
      fallback_urls: [],
    });

    const itemWithDoi = { ...fullItemFixture, DOI: "10.1234/test" };
    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [itemWithDoi] });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ABC12345"], dry_run: true },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.results[0].status).toBe("available");
    expect(parsed.results[0].pdf_url).toBe("https://journal.org/article.pdf");
    expect(vi.mocked(downloadAndUploadPdf)).not.toHaveBeenCalled();
  });

  it("reports not_found for closed access items", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");

    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: false,
        pdf_url: null,
        source: null,
        license: null,
        oa_status: "closed",
      },
      fallback_urls: [],
    });

    const itemWithDoi = { ...fullItemFixture, DOI: "10.1234/closed" };
    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [itemWithDoi] });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ABC12345"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.not_found).toBe(1);
    expect(parsed.results[0].status).toBe("not_found");
  });

  it("processes collection items when collection_key provided", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    const collItem = { key: "COL_ITEM", itemType: "journalArticle", DOI: "10.1234/col" };

    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: true,
        pdf_url: "https://journal.org/col.pdf",
        source: "unpaywall_hybrid",
        license: "cc-by-nc",
        oa_status: "hybrid",
      },
      fallback_urls: [],
    });

    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: true,
      itemKey: "ATT_COL",
      filename: "col.pdf",
      sizeBytes: 2048,
    });

    const { mock, getStub } = createZoteroApiMock([]);
    // Collection items fetch (via fetchAllPages — needs getTotalResults)
    getStub.mockResolvedValueOnce({ getData: () => [collItem], getTotalResults: () => 1 });
    // Batch metadata fetch
    getStub.mockResolvedValueOnce({ getData: () => [collItem], getTotalResults: () => 1 });
    // Children check
    getStub.mockResolvedValueOnce({ getData: () => [], getTotalResults: () => 0 });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { collection_key: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.processed).toBe(1);
    expect(parsed.attached).toBe(1);
  });

  it("reports green OA with landing_url when no direct PDF link", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");

    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: false,
        pdf_url: null,
        landing_url: "https://europepmc.org/articles/PMC7164389",
        source: null,
        license: null,
        oa_status: "green",
      },
      fallback_urls: [],
    });

    const itemWithDoi = { ...fullItemFixture, DOI: "10.1126/science.abb4808" };
    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [itemWithDoi] });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ABC12345"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.not_found).toBe(1);
    expect(parsed.results[0].status).toBe("not_found");
    expect(parsed.results[0].landing_url).toBe("https://europepmc.org/articles/PMC7164389");
    expect(parsed.results[0].oa_status).toBe("green");
    expect(parsed.results[0].reason).toContain("repository");
    expect(parsed.results[0].reason).toContain("import_pdf_to_zotero");
  });

  it("reports quota_exceeded and stops when storage is full (413)", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    const item1 = { ...fullItemFixture, key: "ITEM1", DOI: "10.1234/one" };
    const item2 = { ...fullItemFixture, key: "ITEM2", DOI: "10.1234/two" };

    // Both items have OA PDFs available
    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: true,
        pdf_url: "https://journal.org/one.pdf",
        source: "unpaywall_gold",
        license: "cc-by",
        oa_status: "gold",
      },
      fallback_urls: [],
    });
    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: true,
        pdf_url: "https://journal.org/two.pdf",
        source: "unpaywall_gold",
        license: "cc-by",
        oa_status: "gold",
      },
      fallback_urls: [],
    });

    // First upload returns 413 storage quota exceeded
    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: false,
      itemKey: "ATT_Q1",
      error: {
        code: "storage_quota_exceeded",
        message: "Zotero storage quota exceeded.",
        status: 413,
      },
    });

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [item1, item2] });
    // Children checks (skip_if_attachment_exists=true)
    getStub.mockResolvedValueOnce({ getData: () => [] });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ITEM1", "ITEM2"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.quota_exceeded).toBeGreaterThanOrEqual(1);
    expect(parsed.storage_quota_warning).toContain("storage quota is full");
    // The first item should be quota_exceeded
    const quotaResult = parsed.results.find((r: Record<string, unknown>) => r.status === "quota_exceeded");
    expect(quotaResult).toBeDefined();
    expect(quotaResult.reason).toContain("storage quota");
  });

  it("tries fallback URLs when primary download fails", async () => {
    const { lookupOaPdfWithFallbacks } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    vi.mocked(lookupOaPdfWithFallbacks).mockResolvedValueOnce({
      primary: {
        found: true,
        pdf_url: "https://primary.org/paper.pdf",
        source: "unpaywall_gold",
        license: "cc-by",
        oa_status: "gold",
      },
      fallback_urls: ["https://fallback.org/paper.pdf"],
    });

    // Primary fails
    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: false,
      error: { code: "download_failed", message: "Download failed", status: 500 },
    });
    // Fallback succeeds
    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: true,
      itemKey: "ATT_FB",
      filename: "paper.pdf",
      sizeBytes: 1024,
    });

    const itemWithDoi = { ...fullItemFixture, DOI: "10.1234/test" };
    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => [itemWithDoi] });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { item_keys: ["ABC12345"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.attached).toBe(1);
    expect(parsed.results[0].pdf_url).toBe("https://fallback.org/paper.pdf");
    expect(vi.mocked(downloadAndUploadPdf)).toHaveBeenCalledTimes(2);
  });
});
