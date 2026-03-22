import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleToolCall } from "./index.js";
import { formatErrorResponse } from "../utils/error-formatter.js";
import {
  createZoteroApiMock,
  fullItemFixture,
  minimalItemFixture,
  collectionFixture,
} from "../__mocks__/zotero-api.mock.js";

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
  lookupOaPdf: vi.fn().mockResolvedValue({
    found: false,
    pdf_url: null,
    source: null,
    license: null,
    oa_status: null,
  }),
  lookupOaPdfWithFallbacks: vi.fn(),
}));

vi.mock("../utils/pdf-uploader.js", () => ({
  downloadAndUploadPdf: vi.fn(),
}));

const TEST_USER_ID = "12345";

// ─── formatErrorResponse ────────────────────────────────────────

describe("formatErrorResponse", () => {
  it("returns MCP-formatted error with message", () => {
    const result = formatErrorResponse("Something went wrong");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Something went wrong");
  });

  it("includes additional details", () => {
    const result = formatErrorResponse("Not found", { itemKey: "XYZ", status: "not_found" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Not found");
    expect(parsed.itemKey).toBe("XYZ");
    expect(parsed.status).toBe("not_found");
  });
});

// ─── get_collections ────────────────────────────────────────────

describe("get_collections", () => {
  it("returns collections as JSON", async () => {
    const { mock } = createZoteroApiMock([collectionFixture]);
    const result = await handleToolCall("get_collections", {}, mock, TEST_USER_ID);

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([collectionFixture]);
  });

  it("returns error with suggestion when no collections found", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall("get_collections", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("No collections found");
    expect(parsed.suggestion).toBeDefined();
  });

  it("filters out trashed collections by default", async () => {
    const trashedCollection = { key: "COL002", name: "Old Stuff", deleted: true };
    const { mock } = createZoteroApiMock([collectionFixture, trashedCollection]);
    const result = await handleToolCall("get_collections", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].key).toBe("COL001");
  });

  it("includes trashed collections when include_trashed is true", async () => {
    const trashedCollection = { key: "COL002", name: "Old Stuff", deleted: true };
    const { mock } = createZoteroApiMock([collectionFixture, trashedCollection]);
    const result = await handleToolCall(
      "get_collections",
      { include_trashed: true },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
  });

  it("returns error when all collections are trashed", async () => {
    const trashedOnly = { key: "COL002", name: "Trashed", deleted: true };
    const { mock } = createZoteroApiMock([trashedOnly]);
    const result = await handleToolCall("get_collections", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("No collections found");
    expect(parsed.suggestion).toContain("include_trashed");
  });
});

// ─── get_collection_items ───────────────────────────────────────

describe("get_collection_items", () => {
  it("formats items with all fields correctly", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_items).toBe(1);
    expect(parsed.returned_items).toBe(1);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].title).toBe("Deep Learning for Natural Language Processing");
    expect(parsed.items[0].authors).toBe("John Smith, Jane Doe");
    expect(parsed.items[0].date).toBe("2024-01-15");
    expect(parsed.items[0].key).toBe("ABC12345");
    expect(parsed.items[0].doi).toBe("10.1234/example.2024.001");
    expect(parsed.items[0].tags).toEqual(["deep-learning", "NLP"]);
  });

  it("uses fallback values for minimal items", async () => {
    const { mock } = createZoteroApiMock([minimalItemFixture]);
    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items[0].title).toBe("Untitled");
    expect(parsed.items[0].authors).toBe("No authors listed");
    expect(parsed.items[0].date).toBe("No date");
    expect(parsed.items[0].doi).toBeNull();
    expect(parsed.items[0].tags).toEqual([]);
  });

  it("returns error for empty collection", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "EMPTY" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Collection is empty");
    expect(parsed.status).toBe("empty");
  });

  it("filters out attachments and notes client-side when excludeAttachments is true", async () => {
    const attachmentItem = { key: "ATT001", itemType: "attachment", title: "PDF" };
    const noteItem = { key: "NOTE01", itemType: "note", title: "My note" };
    const { mock } = createZoteroApiMock([fullItemFixture, attachmentItem, noteItem]);
    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_items).toBe(3);
    expect(parsed.returned_items).toBe(1);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].key).toBe("ABC12345");
  });

  it("includes attachments and notes when excludeAttachments is false", async () => {
    const attachmentItem = { key: "ATT001", itemType: "attachment", title: "PDF" };
    const { mock } = createZoteroApiMock([fullItemFixture, attachmentItem]);
    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "COL001", excludeAttachments: false },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_items).toBe(2);
    expect(parsed.returned_items).toBe(2);
    expect(parsed.items).toHaveLength(2);
  });

  it("returns not_found error on 404", async () => {
    const { mock, getStub } = createZoteroApiMock([]);
    const error404 = new Error("Not found") as Error & { response?: { status: number } };
    error404.response = { status: 404 };
    getStub.mockRejectedValueOnce(error404);

    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "MISSING" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Collection is empty or not accessible");
    expect(parsed.status).toBe("not_found");
  });
});

// ─── get_items_details ──────────────────────────────────────────

describe("get_items_details", () => {
  it("returns metadata map for multiple items", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture, minimalItemFixture]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: ["ABC12345", "MIN00001"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed["ABC12345"].title).toBe("Deep Learning for Natural Language Processing");
    expect(parsed["ABC12345"].authors).toBe("John Smith, Jane Doe");
    expect(parsed["ABC12345"].DOI).toBe("10.1234/example.2024.001");
    expect(parsed["ABC12345"].itemType).toBe("journalArticle");
    expect(parsed["ABC12345"].publicationTitle).toBe("Journal of Machine Learning");
    expect(parsed["ABC12345"].url).toBe("https://example.com/paper");
    expect(parsed["MIN00001"].title).toBe("Untitled");
    expect(parsed["MIN00001"].authors).toBe("No authors listed");
    expect(parsed["MIN00001"]).not.toHaveProperty("DOI");
  });

  it("passes itemKey query param to API", async () => {
    const { mock, getStub } = createZoteroApiMock([fullItemFixture]);
    await handleToolCall(
      "get_items_details",
      { item_keys: ["ABC12345", "DEF67890"] },
      mock,
      TEST_USER_ID
    );

    expect(getStub).toHaveBeenCalledWith({ itemKey: "ABC12345,DEF67890" });
  });

  it("excludes abstract from response by default", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: ["ABC12345"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed["ABC12345"]).not.toHaveProperty("abstract");
    expect(parsed["ABC12345"]).not.toHaveProperty("abstractNote");
  });

  it("includes abstract when include_abstract is true", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: ["ABC12345"], include_abstract: true },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed["ABC12345"].abstractNote).toBe(fullItemFixture.abstractNote);
  });

  it("includes type-specific fields from Zotero response", async () => {
    const bookSectionFixture = {
      key: "BS00001",
      itemType: "bookSection",
      title: "A Chapter",
      bookTitle: "The Book",
      publisher: "Publisher",
      pages: "10-20",
      creators: [{ firstName: "Alice", lastName: "Bob", creatorType: "author" }],
    };
    const { mock } = createZoteroApiMock([bookSectionFixture]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: ["BS00001"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed["BS00001"].bookTitle).toBe("The Book");
    expect(parsed["BS00001"].pages).toBe("10-20");
    expect(parsed["BS00001"].publisher).toBe("Publisher");
  });

  it("excludes structural fields (key, version, collections, tags, creators)", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: ["ABC12345"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed["ABC12345"]).not.toHaveProperty("key");
    expect(parsed["ABC12345"]).not.toHaveProperty("version");
    expect(parsed["ABC12345"]).not.toHaveProperty("collections");
    expect(parsed["ABC12345"]).not.toHaveProperty("tags");
    expect(parsed["ABC12345"]).not.toHaveProperty("creators");
    expect(parsed["ABC12345"]).not.toHaveProperty("dateAdded");
    // authors is the formatted version of creators
    expect(parsed["ABC12345"].authors).toBe("John Smith, Jane Doe");
  });

  it("returns error for empty item_keys array", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: [] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("At least one item key is required");
  });

  it("returns error when no items found", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "get_items_details",
      { item_keys: ["NONEXIST"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("No items found for the given keys");
  });
});

// ─── search_library ─────────────────────────────────────────────

describe("search_library", () => {
  it("returns formatted search results", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall(
      "search_library",
      { query: "deep learning" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Deep Learning for Natural Language Processing");
    expect(parsed[0].authors).toBe("John Smith, Jane Doe");
    expect(parsed[0].key).toBe("ABC12345");
  });

  it("passes query and default sort params to API", async () => {
    const { mock, getStub } = createZoteroApiMock([fullItemFixture]);
    await handleToolCall("search_library", { query: "test query" }, mock, TEST_USER_ID);

    expect(getStub).toHaveBeenCalledWith({
      q: "test query",
      sort: "dateAdded",
      direction: "desc",
      limit: 25,
    });
  });

  it("returns recent items when query is omitted (replaces get_recent)", async () => {
    const { mock, getStub } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall("search_library", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Deep Learning for Natural Language Processing");
    expect(parsed[0].dateAdded).toBe("2024-02-01T10:30:00Z");

    expect(getStub).toHaveBeenCalledWith({
      sort: "dateAdded",
      direction: "desc",
      limit: 25,
    });
  });

  it("caps limit at 100", async () => {
    const { mock, getStub } = createZoteroApiMock([fullItemFixture]);
    await handleToolCall("search_library", { limit: 500 }, mock, TEST_USER_ID);

    expect(getStub).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
  });

  it("passes custom sort and direction", async () => {
    const { mock, getStub } = createZoteroApiMock([fullItemFixture]);
    await handleToolCall(
      "search_library",
      { sort: "title", direction: "asc", limit: 5 },
      mock,
      TEST_USER_ID
    );

    expect(getStub).toHaveBeenCalledWith({
      sort: "title",
      direction: "asc",
      limit: 5,
    });
  });

  it("does not include dateAdded when sort is not dateAdded", async () => {
    const { mock } = createZoteroApiMock([fullItemFixture]);
    const result = await handleToolCall(
      "search_library",
      { sort: "title" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed[0]).not.toHaveProperty("dateAdded");
  });

  it("returns error when no results found (with query)", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "search_library",
      { query: "nonexistent topic" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("No results found");
    expect(parsed.query).toBe("nonexistent topic");
  });

  it("returns error when no items found (without query)", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall("search_library", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("No items found");
    expect(parsed.suggestion).toBeDefined();
  });
});


// ─── create_collection ─────────────────────────────────────────

describe("create_collection", () => {
  it("creates collection and returns key + name", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "NEW001", name: "Test Collection" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "create_collection",
      { name: "Test Collection" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.collection_key).toBe("NEW001");
    expect(parsed.name).toBe("Test Collection");
  });

  it("creates collection with parent_collection", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "SUB001", name: "Sub Collection", parentCollection: "PARENT01" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "create_collection",
      { name: "Sub Collection", parent_collection: "PARENT01" },
      mock,
      TEST_USER_ID
    );

    expect(postStub).toHaveBeenCalledWith([
      { name: "Sub Collection", parentCollection: "PARENT01" },
    ]);
  });

  it("returns error for empty name", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "create_collection",
      { name: "   " },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Collection name is required");
  });

  it("returns error when API POST fails", async () => {
    const writeData = {
      isSuccess: false,
      data: [],
      errors: { "0": "Invalid collection data" },
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "create_collection",
      { name: "Fail Collection" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Failed to create collection");
  });
});

// ─── add_items_by_doi ──────────────────────────────────────────

describe("add_items_by_doi", () => {
  it("resolves DOI and creates item successfully", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    const resolveDoiMock = vi.mocked(resolveDois);
    resolveDoiMock.mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/test",
          data: {
            type: "article-journal",
            title: "Test Paper",
            author: [{ family: "Smith", given: "John" }],
            issued: { "date-parts": [["2023"]] },
            DOI: "10.1234/test",
          },
        },
      ],
      failed: [],
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "ITEM001", title: "Test Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/test"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.success[0].doi).toBe("10.1234/test");
    expect(parsed.success[0].item_key).toBe("ITEM001");
    expect(parsed.failed).toHaveLength(0);
  });

  it("handles partially failed DOIs", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    const resolveDoiMock = vi.mocked(resolveDois);
    resolveDoiMock.mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/good",
          data: {
            type: "article-journal",
            title: "Good Paper",
            DOI: "10.1234/good",
          },
        },
      ],
      failed: [{ doi: "10.9999/bad", error: "Not found" }],
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "GOOD01", title: "Good Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/good", "10.9999/bad"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].doi).toBe("10.9999/bad");
  });

  it("returns error when all DOIs fail", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    const resolveDoiMock = vi.mocked(resolveDois);
    resolveDoiMock.mockResolvedValueOnce({
      success: [],
      failed: [
        { doi: "10.9999/bad1", error: "Not found" },
        { doi: "10.9999/bad2", error: "Not found" },
      ],
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.9999/bad1", "10.9999/bad2"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("All DOI resolutions failed");
  });

  it("returns error for empty dois array", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: [] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("At least one DOI is required");
  });

  it("passes collection_key and tags to converter", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    const resolveDoiMock = vi.mocked(resolveDois);
    resolveDoiMock.mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/test",
          data: {
            type: "article-journal",
            title: "Tagged Paper",
            DOI: "10.1234/test",
          },
        },
      ],
      failed: [],
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "TAG001", title: "Tagged Paper" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/test"], collection_key: "COL001", tags: ["ai"] },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("collections", ["COL001"]);
    expect(postedData[0]).toHaveProperty("tags", [{ tag: "ai" }]);
  });

  it("auto-attaches OA PDF when auto_attach_pdf is true (default)", async () => {
    const ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };

    const { resolveDois } = await import("../utils/doi-resolver.js");
    const { lookupOaPdf } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/oa",
          data: {
            type: "article-journal",
            title: "OA Paper",
            DOI: "10.1234/oa",
          },
        },
      ],
      failed: [],
    });

    vi.mocked(lookupOaPdf).mockResolvedValueOnce({
      found: true,
      pdf_url: "https://journal.org/oa.pdf",
      source: "unpaywall_gold",
      license: "cc-by",
      oa_status: "gold",
    });

    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: true,
      itemKey: "ATT_OA",
      filename: "oa.pdf",
      sizeBytes: 1024,
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "OA001", title: "OA Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/oa"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.pdf_results).toHaveLength(1);
    expect(parsed.pdf_results[0].pdf_attached).toBe(true);
    expect(parsed.pdf_results[0].source).toBe("unpaywall_gold");

    process.env = ORIGINAL_ENV;
  });

  it("reports green OA with landing_url when no direct PDF link", async () => {
    const ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };

    const { resolveDois } = await import("../utils/doi-resolver.js");
    const { lookupOaPdf } = await import("../utils/unpaywall.js");

    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1126/science.abb4808",
          data: {
            type: "article-journal",
            title: "Green OA Paper",
            DOI: "10.1126/science.abb4808",
          },
        },
      ],
      failed: [],
    });

    vi.mocked(lookupOaPdf).mockResolvedValueOnce({
      found: false,
      pdf_url: null,
      landing_url: "https://europepmc.org/articles/PMC7164389",
      source: null,
      license: null,
      oa_status: "green",
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "GREEN01", title: "Green OA Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1126/science.abb4808"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pdf_results).toHaveLength(1);
    expect(parsed.pdf_results[0].pdf_attached).toBe(false);
    expect(parsed.pdf_results[0].landing_url).toBe("https://europepmc.org/articles/PMC7164389");
    expect(parsed.pdf_results[0].oa_status).toBe("green");
    expect(parsed.pdf_results[0].error).toContain("repository");

    process.env = ORIGINAL_ENV;
  });

  it("does not attach PDF when auto_attach_pdf is false", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    const { lookupOaPdf } = await import("../utils/unpaywall.js");

    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/test",
          data: {
            type: "article-journal",
            title: "Test Paper",
            DOI: "10.1234/test",
          },
        },
      ],
      failed: [],
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "NOAUTO", title: "Test Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);

    vi.mocked(lookupOaPdf).mockClear();

    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/test"], auto_attach_pdf: false },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.pdf_results).toBeUndefined();
    expect(vi.mocked(lookupOaPdf)).not.toHaveBeenCalled();
  });

  it("throws when Zotero API write fails (isSuccess false)", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/fail",
          data: {
            type: "article-journal",
            title: "Fail Paper",
            DOI: "10.1234/fail",
          },
        },
      ],
      failed: [],
    });

    const writeData = {
      isSuccess: false,
      data: [],
      errors: { "0": "Invalid item type" },
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/fail"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Zotero API write failed");
  });

  it("throws when Zotero API returns empty data", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/empty",
          data: {
            type: "article-journal",
            title: "Empty Paper",
            DOI: "10.1234/empty",
          },
        },
      ],
      failed: [],
    });

    const writeData = {
      isSuccess: true,
      data: [],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/empty"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("empty response");
  });

  it("throws when entity key is missing from response", async () => {
    const { resolveDois } = await import("../utils/doi-resolver.js");
    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/nokey",
          data: {
            type: "article-journal",
            title: "No Key Paper",
            DOI: "10.1234/nokey",
          },
        },
      ],
      failed: [],
    });

    const writeData = {
      isSuccess: true,
      data: [{ title: "No Key Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/nokey"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Failed to get item key");
  });

  it("returns created items even when PDF attach phase throws", async () => {
    const ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };

    const { resolveDois } = await import("../utils/doi-resolver.js");
    const { lookupOaPdf } = await import("../utils/unpaywall.js");

    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/survives",
          data: {
            type: "article-journal",
            title: "Survives PDF Failure",
            DOI: "10.1234/survives",
          },
        },
      ],
      failed: [],
    });

    // Make lookupOaPdf throw to simulate a network failure
    vi.mocked(lookupOaPdf).mockRejectedValueOnce(new Error("Unpaywall unreachable"));

    const writeData = {
      isSuccess: true,
      data: [{ key: "SURV01", title: "Survives PDF Failure" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/survives"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.success[0].item_key).toBe("SURV01");
    expect(parsed.pdf_attach_error).toContain("PDF attachment failed");
    expect(parsed.pdf_attach_error).toContain("Items were created successfully");

    process.env = ORIGINAL_ENV;
  });

  it("reports storage_quota_warning when PDF attach hits 413", async () => {
    const ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };

    const { resolveDois } = await import("../utils/doi-resolver.js");
    const { lookupOaPdf } = await import("../utils/unpaywall.js");
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");

    vi.mocked(resolveDois).mockResolvedValueOnce({
      success: [
        {
          doi: "10.1234/quota",
          data: {
            type: "article-journal",
            title: "Quota Paper",
            DOI: "10.1234/quota",
          },
        },
      ],
      failed: [],
    });

    vi.mocked(lookupOaPdf).mockResolvedValueOnce({
      found: true,
      pdf_url: "https://journal.org/paper.pdf",
      source: "unpaywall_gold",
      license: "cc-by",
      oa_status: "gold",
    });

    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: false,
      itemKey: "QUOTA_ATT",
      error: {
        code: "storage_quota_exceeded",
        message: "Zotero storage quota exceeded.",
        status: 413,
      },
    });

    const writeData = {
      isSuccess: true,
      data: [{ key: "QUOTA01", title: "Quota Paper" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items_by_doi",
      { dois: ["10.1234/quota"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.success[0].item_key).toBe("QUOTA01");
    expect(parsed.pdf_results).toHaveLength(1);
    expect(parsed.pdf_results[0].pdf_attached).toBe(false);
    expect(parsed.storage_quota_warning).toContain("storage quota is full");

    process.env = ORIGINAL_ENV;
  });
});

// ─── get_item_fulltext ─────────────────────────────────────────

describe("get_item_fulltext", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("returns fulltext successfully", async () => {
    const parentItem = { ...fullItemFixture, itemType: "journalArticle" };
    const pdfChild = {
      key: "ATTACH01",
      itemType: "attachment",
      contentType: "application/pdf",
      title: "Full Text PDF",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    // First call: parent item metadata
    getStub.mockResolvedValueOnce({ getData: () => parentItem });
    // Second call: children
    getStub.mockResolvedValueOnce({ getData: () => [pdfChild] });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            content: "This is the full text of the paper.",
            indexedPages: 10,
            totalPages: 10,
          }),
      })
    );

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ABC12345" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("ABC12345");
    expect(parsed.attachment_key).toBe("ATTACH01");
    expect(parsed.text).toBe("This is the full text of the paper.");
    expect(parsed.truncated).toBe(false);
    expect(parsed.pages).toBe(10);
  });

  it("returns error when fulltext not indexed (404)", async () => {
    const parentItem = { ...fullItemFixture, itemType: "journalArticle" };
    const pdfChild = {
      key: "ATTACH01",
      itemType: "attachment",
      contentType: "application/pdf",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => parentItem });
    getStub.mockResolvedValueOnce({ getData: () => [pdfChild] });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 404 })
    );

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ABC12345" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Full text not indexed");
  });

  it("returns error when no PDF attachment found", async () => {
    const parentItem = { ...fullItemFixture, itemType: "journalArticle", url: undefined };
    const noteChild = { key: "NOTE01", itemType: "note", title: "My notes" };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => ({ ...parentItem, url: undefined }) });
    getStub.mockResolvedValueOnce({ getData: () => [noteChild] });

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ABC12345" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("No PDF attachment found");
  });

  it("returns URL suggestion for items with URL but no PDF", async () => {
    const parentItem = {
      ...fullItemFixture,
      itemType: "journalArticle",
      url: "https://example.com/paper",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => parentItem });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ABC12345" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("URL");
    expect(parsed.url).toBe("https://example.com/paper");
  });

  it("returns URL suggestion for webpage itemType", async () => {
    const webpageItem = {
      key: "WEB001",
      itemType: "webpage",
      title: "Some Blog Post",
      url: "https://example.com/blog",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => webpageItem });
    getStub.mockResolvedValueOnce({ getData: () => [] });

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "WEB001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("web page");
  });

  it("handles direct attachment key", async () => {
    const attachmentItem = {
      key: "ATTACH01",
      itemType: "attachment",
      contentType: "application/pdf",
      title: "Full Text PDF",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => attachmentItem });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: "Direct attachment text." }),
      })
    );

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ATTACH01" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("ATTACH01");
    expect(parsed.attachment_key).toBe("ATTACH01");
    expect(parsed.text).toBe("Direct attachment text.");
  });

  it("truncates text when exceeding max_characters", async () => {
    const parentItem = { ...fullItemFixture, itemType: "journalArticle" };
    const pdfChild = {
      key: "ATTACH01",
      itemType: "attachment",
      contentType: "application/pdf",
    };

    const { mock, getStub } = createZoteroApiMock([]);
    getStub.mockResolvedValueOnce({ getData: () => parentItem });
    getStub.mockResolvedValueOnce({ getData: () => [pdfChild] });

    const longText = "A".repeat(200);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ content: longText }),
      })
    );

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "ABC12345", max_characters: 100 },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.characters).toBe(100);
    expect(parsed.text).toHaveLength(100);
  });

  it("returns error for non-existent item (404)", async () => {
    const { mock, getStub } = createZoteroApiMock([]);
    const error404 = new Error("Not found") as Error & { response?: { status: number } };
    error404.response = { status: 404 };
    getStub.mockRejectedValueOnce(error404);

    const result = await handleToolCall(
      "get_item_fulltext",
      { item_key: "NONEXIST" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Item not found");
  });
});

// ─── inject_citations ──────────────────────────────────────────

describe("inject_citations", () => {
  it("returns error for missing file_path", async () => {
    const { mock } = createZoteroApiMock([]);
    await expect(
      handleToolCall("inject_citations", {}, mock, TEST_USER_ID)
    ).rejects.toThrow();
  });

  it("returns error for non-.docx file", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "inject_citations",
      { file_path: "/tmp/document.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("File must be a .docx file");
  });

  it("calls injectCitations and returns result", async () => {
    const { injectCitations: injectMock } = await import(
      "../citation-injector/injector.js"
    );
    vi.mocked(injectMock).mockResolvedValueOnce({
      outputPath: "/tmp/doc_cited.docx",
      found: 3,
      injected: 3,
      warnings: [],
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "inject_citations",
      { file_path: "/tmp/doc.docx", style: "apa" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.output_path).toBe("/tmp/doc_cited.docx");
    expect(parsed.citations_found).toBe(3);
    expect(parsed.citations_injected).toBe(3);
  });
});

// ─── get_user_id ────────────────────────────────────────────────

describe("get_user_id", () => {
  it("returns the configured user ID", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall("get_user_id", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.user_id).toBe(TEST_USER_ID);
  });
});

// ─── add_linked_url_attachment ──────────────────────────────────

describe("add_linked_url_attachment", () => {
  it("creates standalone attachment with minimal args (url only)", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ATT001", title: "https://arxiv.org/abs/2301.00001" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_linked_url_attachment",
      { url: "https://arxiv.org/abs/2301.00001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("ATT001");
    expect(parsed.url).toBe("https://arxiv.org/abs/2301.00001");
    expect(parsed.parent_item).toBeNull();
    expect(parsed.link_mode).toBe("linked_url");
  });

  it("creates child attachment with parent_item and content_type", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ATT002", title: "Paper PDF" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_linked_url_attachment",
      {
        url: "https://arxiv.org/pdf/2301.00001.pdf",
        title: "Paper PDF",
        parent_item: "PARENT1",
        content_type: "application/pdf",
      },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("ATT002");
    expect(parsed.parent_item).toBe("PARENT1");

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("parentItem", "PARENT1");
    expect(postedData[0]).toHaveProperty("contentType", "application/pdf");
    expect(postedData[0]).toHaveProperty("linkMode", "linked_url");
  });

  it("uses url as title when title is not provided", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ATT003" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_linked_url_attachment",
      { url: "https://example.com/resource" },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("title", "https://example.com/resource");
  });

  it("sets collections for standalone attachment", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ATT004" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_linked_url_attachment",
      { url: "https://example.com", collections: ["COL001", "COL002"] },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("collections", ["COL001", "COL002"]);
  });

  it("forces collections=[] when parent_item is present", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ATT005" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_linked_url_attachment",
      {
        url: "https://example.com",
        parent_item: "PARENT1",
        collections: ["COL001"],
      },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("collections", []);
    expect(postedData[0]).toHaveProperty("parentItem", "PARENT1");
  });

  it("converts tags to Zotero format", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ATT006" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_linked_url_attachment",
      { url: "https://example.com", tags: ["ai", "nlp"] },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("tags", [{ tag: "ai" }, { tag: "nlp" }]);
  });

  it("returns error when POST fails", async () => {
    const writeData = {
      isSuccess: false,
      data: [],
      errors: { "0": "Invalid attachment data" },
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_linked_url_attachment",
      { url: "https://example.com" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Failed to create linked URL attachment");
  });
});

// ─── add_items ──────────────────────────────────────────────────

describe("add_items", () => {
  it("creates single item (book) with minimal fields", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "BOOK01", title: "My Book" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items",
      {
        items: [
          { itemType: "book", title: "My Book", publisher: "Penguin" },
        ],
      },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.success[0].item_key).toBe("BOOK01");
    expect(parsed.success[0].title).toBe("My Book");
    expect(parsed.success[0].item_type).toBe("book");
  });

  it("creates batch of mixed types (journalArticle + book + thesis)", async () => {
    const writeData = {
      isSuccess: true,
      data: [
        { key: "ART01", title: "Paper" },
        { key: "BOOK02", title: "Book" },
        { key: "THE01", title: "Thesis" },
      ],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items",
      {
        items: [
          { itemType: "journalArticle", title: "Paper", DOI: "10.1234/test" },
          { itemType: "book", title: "Book", publisher: "Publisher" },
          { itemType: "thesis", title: "Thesis", university: "MIT" },
        ],
      },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(3);
    expect(parsed.success[0].item_type).toBe("journalArticle");
    expect(parsed.success[1].item_type).toBe("book");
    expect(parsed.success[2].item_type).toBe("thesis");
  });

  it("applies collection_key and tags to all items", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "ITEM01", title: "Test" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_items",
      {
        items: [{ itemType: "book", title: "Test" }],
        collection_key: "COL001",
        tags: ["ai", "nlp"],
      },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("collections", ["COL001"]);
    expect(postedData[0]).toHaveProperty("tags", [
      { tag: "ai" },
      { tag: "nlp" },
    ]);
  });

  it("sets accessDate when url is provided", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "WEB01", title: "Test" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_items",
      {
        items: [
          {
            itemType: "webpage",
            title: "Test",
            url: "https://example.com",
          },
        ],
      },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("accessDate");
    expect(postedData[0].accessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns per-item success with item_key, title, item_type", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "RES01", title: "Result" }],
      errors: {},
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items",
      {
        items: [{ itemType: "report", title: "Result", institution: "MIT" }],
      },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success[0]).toEqual({
      index: 0,
      item_key: "RES01",
      title: "Result",
      item_type: "report",
    });
  });

  it("returns partial success when some items fail in batch", async () => {
    const writeData = {
      isSuccess: false,
      data: [{ key: "OK01", title: "Good" }],
      errors: { "1": "Invalid field" },
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items",
      {
        items: [
          { itemType: "book", title: "Good", publisher: "Pub" },
          { itemType: "book", title: "Bad" },
        ],
      },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toHaveLength(1);
    expect(parsed.success[0].item_key).toBe("OK01");
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].error).toBe("Invalid field");
  });

  it("returns error when all items fail", async () => {
    const writeData = {
      isSuccess: false,
      data: [],
      errors: { "0": "Bad data" },
    };
    const { mock } = createZoteroApiMock([], writeData);
    const result = await handleToolCall(
      "add_items",
      {
        items: [{ itemType: "book", title: "Bad" }],
      },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("All items failed to create");
    expect(parsed.failed).toHaveLength(1);
  });

  it("handles creators with various creatorTypes", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "FILM01", title: "Movie" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_items",
      {
        items: [
          {
            itemType: "film",
            title: "Movie",
            creators: [
              { firstName: "Steven", lastName: "Spielberg", creatorType: "director" },
              { name: "DreamWorks", creatorType: "producer" },
            ],
          },
        ],
      },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    const creators = postedData[0].creators as Record<string, string>[];
    expect(creators).toHaveLength(2);
    expect(creators[0]).toEqual({
      firstName: "Steven",
      lastName: "Spielberg",
      creatorType: "director",
    });
    expect(creators[1]).toEqual({
      name: "DreamWorks",
      creatorType: "producer",
    });
  });

  it("maps title to caseName for case type", async () => {
    const writeData = {
      isSuccess: true,
      data: [{ key: "CASE01", title: "Test v. State" }],
      errors: {},
    };
    const { mock, postStub } = createZoteroApiMock([], writeData);
    await handleToolCall(
      "add_items",
      {
        items: [
          { itemType: "case", title: "Test v. State", court: "Supreme Court" },
        ],
      },
      mock,
      TEST_USER_ID
    );

    const postedData = postStub.mock.calls[0][0] as Record<string, unknown>[];
    expect(postedData[0]).toHaveProperty("caseName", "Test v. State");
    expect(postedData[0]).not.toHaveProperty("title");
  });
});

// ─── import_pdf_to_zotero ───────────────────────────────────────

describe("import_pdf_to_zotero", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  async function mockUploader(result: Record<string, unknown>) {
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");
    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce(result as ReturnType<typeof downloadAndUploadPdf> extends Promise<infer R> ? R : never);
  }

  it("downloads and uploads with minimal args (url only)", async () => {
    await mockUploader({
      success: true,
      itemKey: "IMP001",
      filename: "2301.00001.pdf",
      sizeBytes: 16,
      fulltextIndexed: true,
      fulltextStatus: "Fulltext indexed successfully. Use get_item_fulltext to retrieve content.",
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://arxiv.org/pdf/2301.00001.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("IMP001");
    expect(parsed.filename).toBe("2301.00001.pdf");
    expect(parsed.link_mode).toBe("imported_url");
    expect(parsed.size_bytes).toBe(16);
    expect(parsed.parent_item).toBeNull();
    expect(parsed.fulltext_indexed).toBe(true);
  });

  it("passes correct options to downloadAndUploadPdf", async () => {
    const { downloadAndUploadPdf } = await import("../utils/pdf-uploader.js");
    vi.mocked(downloadAndUploadPdf).mockClear();
    vi.mocked(downloadAndUploadPdf).mockResolvedValueOnce({
      success: true,
      itemKey: "IMP002",
      filename: "paper.pdf",
      sizeBytes: 16,
      fulltextIndexed: true,
      fulltextStatus: "Fulltext indexed successfully.",
    });

    const { mock } = createZoteroApiMock([]);
    await handleToolCall(
      "import_pdf_to_zotero",
      {
        url: "https://example.com/paper.pdf",
        parent_item: "PARENT1",
        collections: ["COL001"],
        tags: ["ai"],
        filename: "custom.pdf",
        title: "Custom Title",
      },
      mock,
      TEST_USER_ID
    );

    expect(vi.mocked(downloadAndUploadPdf)).toHaveBeenCalledWith(
      expect.anything(), // zoteroApi proxy
      TEST_USER_ID,
      "test-api-key",
      {
        url: "https://example.com/paper.pdf",
        parentItem: "PARENT1",
        collections: ["COL001"],
        tags: ["ai"],
        filename: "custom.pdf",
        title: "Custom Title",
        contentType: "application/pdf",
      }
    );
  });

  it("returns error when download fails", async () => {
    await mockUploader({
      success: false,
      error: { code: "download_failed", message: "Failed to download file from URL (status 403)", status: 403 },
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/forbidden.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Failed to download file from URL");
    expect(parsed.status).toBe(403);
  });

  it("returns error when file exceeds 100 MB", async () => {
    await mockUploader({
      success: false,
      error: { code: "file_too_large", message: "File exceeds 100 MB limit (105906176 bytes)", sizeBytes: 105906176 },
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/huge.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("File exceeds 100 MB limit");
    expect(parsed.size_bytes).toBeGreaterThan(100 * 1024 * 1024);
  });

  it("returns error when upload authorization fails", async () => {
    await mockUploader({
      success: false,
      error: { code: "auth_failed", message: "Upload authorization failed (status 403)", status: 403 },
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/paper.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Upload authorization failed");
    expect(parsed.status).toBe(403);
  });

  it("returns descriptive error when download fetch throws (network error)", async () => {
    await mockUploader({
      success: false,
      error: { code: "network_error", message: "Network error downloading file: fetch failed.", networkDetail: "fetch failed" },
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://www.frontiersin.org/articles/10.3389/fmed.2022.943631/pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Network error downloading file");
    expect(parsed.details).toBe("fetch failed");
    expect(parsed.url).toContain("frontiersin.org");
    expect(parsed.suggestion).toBeDefined();
  });

  it("indexes fulltext successfully after PDF upload", async () => {
    await mockUploader({
      success: true,
      itemKey: "IMP010",
      filename: "paper.pdf",
      sizeBytes: 16,
      fulltextIndexed: true,
      fulltextStatus: "Fulltext indexed successfully. Use get_item_fulltext to retrieve content.",
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/paper.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.fulltext_indexed).toBe(true);
    expect(parsed.fulltext_status).toContain("Fulltext indexed successfully");
  });

  it("handles PDF text extraction failure gracefully", async () => {
    await mockUploader({
      success: true,
      itemKey: "IMP011",
      filename: "corrupt.pdf",
      sizeBytes: 16,
      fulltextIndexed: false,
      fulltextStatus: "PDF text extraction failed. Sync with Zotero Desktop to index the PDF.",
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/corrupt.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("IMP011");
    expect(parsed.fulltext_indexed).toBe(false);
    expect(parsed.fulltext_status).toContain("PDF text extraction failed");
  });

  it("handles fulltext PUT failure gracefully", async () => {
    await mockUploader({
      success: true,
      itemKey: "IMP012",
      filename: "paper.pdf",
      sizeBytes: 16,
      fulltextIndexed: false,
      fulltextStatus: "Fulltext PUT failed: Fulltext PUT failed with status 500. Sync with Zotero Desktop to index the PDF.",
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/paper.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("IMP012");
    expect(parsed.fulltext_indexed).toBe(false);
    expect(parsed.fulltext_status).toContain("Fulltext PUT failed");
  });

  it("skips fulltext extraction for non-PDF content types", async () => {
    await mockUploader({
      success: true,
      itemKey: "IMP013",
      filename: "image.png",
      sizeBytes: 16,
      fulltextIndexed: false,
      fulltextStatus: "Non-PDF content type, fulltext extraction skipped.",
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/image.png", content_type: "image/png", filename: "image.png" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.item_key).toBe("IMP013");
    expect(parsed.fulltext_indexed).toBe(false);
    expect(parsed.fulltext_status).toContain("Non-PDF content type");
  });

  it("returns actionable error when storage quota is exceeded (413)", async () => {
    await mockUploader({
      success: false,
      itemKey: "QUOTA1",
      error: {
        code: "storage_quota_exceeded",
        message: "Zotero storage quota exceeded.",
        status: 413,
      },
    });

    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "import_pdf_to_zotero",
      { url: "https://example.com/paper.pdf" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Zotero storage quota exceeded");
    expect(parsed.status).toBe(413);
    expect(parsed.suggestion).toContain("zotero.org/settings/storage");
    expect(parsed.item_key).toBe("QUOTA1");
    expect(parsed.note).toContain("attachment metadata record was created");
  });
});

// ─── delete_collection ──────────────────────────────────────────

describe("delete_collection", () => {
  it("returns permission error when unsafeOps is 'none'", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "delete_collection",
      { collection_key: "COL001" },
      mock,
      TEST_USER_ID,
      "none"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not allowed");
    expect(parsed.env_var).toBe("UNSAFE_OPERATIONS");
    expect(parsed.current_value).toBe("none");
    expect(parsed.required_values).toEqual(["all"]);
  });

  it("returns permission error when unsafeOps is 'items'", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "delete_collection",
      { collection_key: "COL001" },
      mock,
      TEST_USER_ID,
      "items"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not allowed");
    expect(parsed.current_value).toBe("items");
  });

  it("returns permission error when unsafeOps defaults to 'none'", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "delete_collection",
      { collection_key: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not allowed");
  });

  it("deletes collection successfully with 'all' mode", async () => {
    const collectionData = { key: "COL001", name: "Test Collection", version: 5 };
    const { mock, deleteStub } = createZoteroApiMock(collectionData);
    const result = await handleToolCall(
      "delete_collection",
      { collection_key: "COL001" },
      mock,
      TEST_USER_ID,
      "all"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(true);
    expect(parsed.collection_key).toBe("COL001");
    expect(parsed.name).toBe("Test Collection");
    expect(deleteStub).toHaveBeenCalled();
  });

  it("returns error for non-existent collection (404)", async () => {
    const { mock, getStub } = createZoteroApiMock([]);
    const error404 = new Error("Not found") as Error & { response?: { status: number } };
    error404.response = { status: 404 };
    getStub.mockRejectedValueOnce(error404);

    const result = await handleToolCall(
      "delete_collection",
      { collection_key: "MISSING" },
      mock,
      TEST_USER_ID,
      "all"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Collection not found");
    expect(parsed.status).toBe("not_found");
  });

  it("returns error on version conflict (412)", async () => {
    const { mock, getStub } = createZoteroApiMock([]);
    const error412 = new Error("Precondition failed") as Error & { response?: { status: number } };
    error412.response = { status: 412 };
    getStub.mockRejectedValueOnce(error412);

    const result = await handleToolCall(
      "delete_collection",
      { collection_key: "COL001" },
      mock,
      TEST_USER_ID,
      "all"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("modified by another client");
    expect(parsed.status).toBe("version_conflict");
  });
});

// ─── delete_items ───────────────────────────────────────────────

describe("delete_items", () => {
  it("returns permission error when unsafeOps is 'none'", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1"] },
      mock,
      TEST_USER_ID,
      "none"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not allowed");
    expect(parsed.env_var).toBe("UNSAFE_OPERATIONS");
    expect(parsed.current_value).toBe("none");
    expect(parsed.required_values).toEqual(["items", "all"]);
  });

  it("returns permission error when unsafeOps defaults to 'none'", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1"] },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("not allowed");
  });

  it("deletes items successfully with 'items' mode", async () => {
    const itemsData = [
      { key: "KEY1", version: 5, title: "Item 1" },
      { key: "KEY2", version: 3, title: "Item 2" },
    ];
    const { mock, deleteStub } = createZoteroApiMock(itemsData);
    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1", "KEY2"] },
      mock,
      TEST_USER_ID,
      "items"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted_count).toBe(2);
    expect(parsed.deleted_keys).toEqual(expect.arrayContaining(["KEY1", "KEY2"]));
    expect(parsed.not_found).toBeUndefined();
    expect(deleteStub).toHaveBeenCalled();
  });

  it("deletes items successfully with 'all' mode", async () => {
    const itemsData = [{ key: "KEY1", version: 2, title: "Item 1" }];
    const { mock } = createZoteroApiMock(itemsData);
    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1"] },
      mock,
      TEST_USER_ID,
      "all"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted_count).toBe(1);
    expect(parsed.deleted_keys).toEqual(["KEY1"]);
  });

  it("reports not_found keys in partial deletion", async () => {
    const itemsData = [{ key: "KEY1", version: 4, title: "Item 1" }];
    const { mock } = createZoteroApiMock(itemsData);
    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1", "MISSING1"] },
      mock,
      TEST_USER_ID,
      "items"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted_count).toBe(1);
    expect(parsed.deleted_keys).toEqual(["KEY1"]);
    expect(parsed.not_found).toEqual(["MISSING1"]);
  });

  it("returns error when all keys not found", async () => {
    const { mock } = createZoteroApiMock([]);
    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["MISS1", "MISS2"] },
      mock,
      TEST_USER_ID,
      "items"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("No items found for the given keys");
    expect(parsed.status).toBe("not_found");
  });

  it("returns error on version conflict (412)", async () => {
    const itemsData = [{ key: "KEY1", version: 5, title: "Item 1" }];
    const { mock, getStub, deleteStub } = createZoteroApiMock(itemsData);
    const error412 = new Error("Precondition failed") as Error & { response?: { status: number } };
    error412.response = { status: 412 };
    // First get succeeds (returns items), then delete throws 412
    deleteStub.mockRejectedValueOnce(error412);

    const result = await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1"] },
      mock,
      TEST_USER_ID,
      "items"
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("modified by another client");
    expect(parsed.status).toBe("version_conflict");
  });

  it("passes correct keys to delete API call", async () => {
    const itemsData = [
      { key: "KEY1", version: 10, title: "Item 1" },
      { key: "KEY2", version: 8, title: "Item 2" },
    ];
    const { mock, deleteStub } = createZoteroApiMock(itemsData);
    await handleToolCall(
      "delete_items",
      { item_keys: ["KEY1", "KEY2"] },
      mock,
      TEST_USER_ID,
      "items"
    );

    expect(deleteStub).toHaveBeenCalledWith(
      expect.arrayContaining(["KEY1", "KEY2"])
    );
  });
});

// ─── Pagination integration tests ───────────────────────────────

describe("pagination: get_collection_items", () => {
  it("fetches all items across multiple pages (150 items)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      key: `K${i}`,
      itemType: "journalArticle",
      title: `Paper ${i}`,
    }));
    const page2 = Array.from({ length: 50 }, (_, i) => ({
      key: `K${100 + i}`,
      itemType: "journalArticle",
      title: `Paper ${100 + i}`,
    }));

    const { mock, getStub } = createZoteroApiMock([]);
    getStub
      .mockResolvedValueOnce({ getData: () => page1, getTotalResults: () => 150 })
      .mockResolvedValueOnce({ getData: () => page2, getTotalResults: () => 150 });

    const result = await handleToolCall(
      "get_collection_items",
      { collectionKey: "COL001" },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_items).toBe(150);
    expect(parsed.returned_items).toBe(150);
    expect(parsed.items).toHaveLength(150);
    expect(getStub).toHaveBeenCalledTimes(2);
    expect(getStub).toHaveBeenCalledWith({ limit: 100, start: 0 });
    expect(getStub).toHaveBeenCalledWith({ limit: 100, start: 100 });
  });
});

describe("pagination: get_collections", () => {
  it("fetches all collections across multiple pages (130 collections)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      key: `C${i}`,
      name: `Collection ${i}`,
    }));
    const page2 = Array.from({ length: 30 }, (_, i) => ({
      key: `C${100 + i}`,
      name: `Collection ${100 + i}`,
    }));

    const { mock, getStub } = createZoteroApiMock([]);
    getStub
      .mockResolvedValueOnce({ getData: () => page1, getTotalResults: () => 130 })
      .mockResolvedValueOnce({ getData: () => page2, getTotalResults: () => 130 });

    const result = await handleToolCall("get_collections", {}, mock, TEST_USER_ID);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(130);
    expect(getStub).toHaveBeenCalledTimes(2);
  });
});

describe("pagination: find_and_attach_pdfs with collection_key", () => {
  it("fetches all collection items across multiple pages (120 items)", async () => {
    const ORIGINAL_ENV = process.env;
    process.env = { ...ORIGINAL_ENV, ZOTERO_API_KEY: "test-api-key" };

    const page1 = Array.from({ length: 100 }, (_, i) => ({
      key: `K${i}`,
      itemType: "journalArticle",
    }));
    const page2 = Array.from({ length: 20 }, (_, i) => ({
      key: `K${100 + i}`,
      itemType: "journalArticle",
    }));
    // Metadata items (only first 100 via itemKey batch)
    const allItems = [...page1, ...page2].map((item) => ({
      ...item,
      DOI: `10.1234/${item.key}`,
    }));

    const { mock, getStub } = createZoteroApiMock([]);
    // Page 1 of collection items (via fetchAllPages)
    getStub.mockResolvedValueOnce({ getData: () => page1, getTotalResults: () => 120 });
    // Page 2 of collection items (via fetchAllPages)
    getStub.mockResolvedValueOnce({ getData: () => page2, getTotalResults: () => 120 });
    // Batch metadata fetch — returns items with DOIs
    getStub.mockResolvedValueOnce({ getData: () => allItems, getTotalResults: () => 120 });

    const result = await handleToolCall(
      "find_and_attach_pdfs",
      { collection_key: "COL001", dry_run: true, skip_if_attachment_exists: false },
      mock,
      TEST_USER_ID
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.processed).toBe(120);

    process.env = ORIGINAL_ENV;
  });
});

// ─── Unknown tool ───────────────────────────────────────────────

describe("Unknown tool", () => {
  it("throws Error for unknown tool name", async () => {
    const { mock } = createZoteroApiMock([]);
    await expect(
      handleToolCall("nonexistent_tool", {}, mock, TEST_USER_ID)
    ).rejects.toThrow("Unknown tool: nonexistent_tool");
  });
});
