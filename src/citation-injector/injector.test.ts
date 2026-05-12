import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectCitations } from "./injector.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";

vi.mock("jszip", () => {
  const mockZip = {
    files: {} as Record<string, unknown>,
    file: vi.fn(),
    generateAsync: vi.fn(),
  };

  return {
    default: {
      loadAsync: vi.fn().mockResolvedValue(mockZip),
    },
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-docx")),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

function createMockZoteroApi(getStub: ReturnType<typeof vi.fn>): ZoteroApiInterface {
  const chainable: Record<string, unknown> = {};
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      if (prop === "get") return getStub;
      return (..._args: unknown[]) => new Proxy(chainable, handler);
    },
  };
  return new Proxy(chainable, handler) as unknown as ZoteroApiInterface;
}

async function setupJsZipMock(documentXml: string) {
  const JSZip = (await import("jszip")).default;

  const fileMap: Record<string, { async: () => Promise<string> }> = {
    "word/document.xml": {
      async: () => Promise.resolve(documentXml),
    },
  };

  const mockZipInstance = {
    file: vi.fn().mockImplementation((path: string, content?: string) => {
      if (content !== undefined) {
        fileMap[path] = { async: () => Promise.resolve(content) };
        return mockZipInstance;
      }
      return fileMap[path] ?? null;
    }),
    generateAsync: vi.fn().mockResolvedValue(Buffer.from("output-docx")),
  };

  vi.mocked(JSZip.loadAsync).mockResolvedValue(
    mockZipInstance as unknown as InstanceType<typeof import("jszip").default>
  );

  return mockZipInstance;
}

const TEST_USER_ID = "12345";

// Mock returns Zotero-format data (injector converts to CSL internally)
const defaultZoteroData = {
  getData: () => ({
    itemType: "journalArticle",
    title: "Test Paper",
    creators: [{ firstName: "John", lastName: "Smith", creatorType: "author" }],
    date: "2023",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("injectCitations", () => {
  it("replaces a single <zcite> tag with field code", async () => {
    const xml = [
      "<w:body>",
      "<w:p><w:r><w:t>Some text </w:t></w:r>",
      '<w:r><w:t>&lt;zcite keys=&quot;ABC001&quot;/&gt;</w:t></w:r>',
      "<w:r><w:t> more text</w:t></w:r></w:p>",
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
    expect(result.outputPath).toBe("/tmp/test_cited.docx");

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    expect(writeCall).toBeDefined();
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("ADDIN ZOTERO_ITEM");
    expect(writtenXml).toContain("ZOTERO_BIBL");
  });

  it("handles multiple zcite tags in one document", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;DEF002&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(2);
    expect(result.injected).toBe(2);
  });

  it('handles multi-citation tag <zcite keys="ABC,DEF"/>', async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001,DEF002&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
  });

  it("handles tag with locator attribute", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot; locator=&quot;pp. 12-15&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("pp. 12-15");
  });

  it("handles tag with prefix and suffix attributes", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot; prefix=&quot;see &quot; suffix=&quot;, emphasis added&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("see ");
    expect(writtenXml).toContain("emphasis added");
  });

  it("returns unchanged file when no zcite tags found", async () => {
    const xml =
      "<w:body><w:p><w:r><w:t>Plain text</w:t></w:r></w:p></w:body>";

    await setupJsZipMock(xml);
    const getStub = vi.fn();
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(0);
    expect(result.injected).toBe(0);
  });

  it("appends bibliography before </w:body>", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID, "apa");

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toMatch(/ZOTERO_BIBL.*<\/w:body>/s);
  });

  it("handles tag with num attribute for numeric styles", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot; num=&quot;1&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "ieee"
    );

    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("[1]");
  });

  it("warns when vancouver style tags are missing num attribute", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;DEF002&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "vancouver"
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("vancouver");
    expect(result.warnings[0]).toContain("0/2");
  });

  it("no warnings when all vancouver tags have num", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot; num=&quot;1&quot;/&gt;</w:t></w:r></w:p>',
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;DEF002&quot; num=&quot;2&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "vancouver"
    );

    expect(result.warnings).toHaveLength(0);
  });

  it("no warnings for apa style regardless of num", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.warnings).toHaveLength(0);
  });

  it("handles minified XML without matching across runs", async () => {
    // Regression test: minified XML (no newlines) where multiple <w:rPr> exist.
    // The old .*? regex could backtrack past the first </w:rPr> and match
    // from the first <w:r> all the way to the zcite run, destroying content.
    // Key: the zcite run ALSO has <w:rPr>, which lets .*? backtrack to it.
    const xml =
      '<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r>' +
      '<w:r><w:rPr><w:i/></w:rPr><w:t>Subtitle</w:t></w:r>' +
      '<w:r><w:rPr><w:noProof/></w:rPr><w:t>&lt;zcite keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p></w:body>';

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    // The original Title and Subtitle runs must be preserved
    expect(writtenXml).toContain("<w:t>Title</w:t>");
    expect(writtenXml).toContain("<w:t>Subtitle</w:t>");
    expect(writtenXml).toContain("ADDIN ZOTERO_ITEM");
  });

  it("handles attributes in non-standard order (num before keys)", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite num=&quot;1&quot; keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "ieee"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("[1]");
    expect(writtenXml).toContain("ADDIN ZOTERO_ITEM");
  });

  it("handles XML entity in attribute value (&amp; in locator)", async () => {
    // In .docx XML, a zcite with locator "pp. 12 & 15" would appear as:
    // &lt;zcite keys=&quot;ABC001&quot; locator=&quot;pp. 12 &amp;amp; 15&quot;/&gt;
    // (double-escaped: &amp; in XML attribute, then the whole tag is entity-escaped in w:t)
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;ABC001&quot; locator=&quot;pp. 12 &amp;amp; 15&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    // The locator value "pp. 12 & 15" appears inside JSON in w:instrText,
    // where & is XML-escaped to &amp;
    expect(writtenXml).toContain("pp. 12 &amp; 15");
  });

  it("handles all attributes in arbitrary order", async () => {
    const xml = [
      "<w:body>",
      '<w:p><w:r><w:t>&lt;zcite suffix=&quot;, emphasis&quot; num=&quot;3&quot; prefix=&quot;see &quot; locator=&quot;p. 5&quot; keys=&quot;ABC001&quot;/&gt;</w:t></w:r></w:p>',
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "ieee"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("[3]");
    expect(writtenXml).toContain("see ");
    expect(writtenXml).toContain("emphasis");
    expect(writtenXml).toContain("p. 5");
  });

  it("handles zcite split across runs (integration)", async () => {
    const xml = [
      "<w:body>",
      "<w:p>",
      '<w:r><w:rPr><w:lang w:val="en-US"/></w:rPr><w:t>&lt;zcite keys=&quot;AB</w:t></w:r>',
      '<w:r><w:rPr><w:lang w:val="it-IT"/></w:rPr><w:t>C001&quot;/&gt;</w:t></w:r>',
      "</w:p>",
      "</w:body>",
    ].join("");

    const zipMock = await setupJsZipMock(xml);
    const getStub = vi.fn().mockResolvedValue(defaultZoteroData);
    const api = createMockZoteroApi(getStub);

    const result = await injectCitations("/tmp/test.docx", api, "user", TEST_USER_ID,
      "apa"
    );

    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);

    const writeCall = zipMock.file.mock.calls.find(
      (c: unknown[]) => c[0] === "word/document.xml" && c.length === 2
    );
    const writtenXml = writeCall![1] as string;
    expect(writtenXml).toContain("ADDIN ZOTERO_ITEM");
  });

  it("throws on invalid docx (no word/document.xml)", async () => {
    const JSZip = (await import("jszip")).default;
    vi.mocked(JSZip.loadAsync).mockResolvedValueOnce({
      file: vi.fn().mockReturnValue(null),
      generateAsync: vi.fn(),
    } as unknown as InstanceType<typeof import("jszip").default>);

    const getStub = vi.fn();
    const api = createMockZoteroApi(getStub);

    await expect(
      injectCitations("/tmp/bad.docx", api, "user", TEST_USER_ID, "apa")
    ).rejects.toThrow("Invalid .docx file: word/document.xml not found");
  });
});
