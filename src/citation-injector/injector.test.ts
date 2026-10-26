import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { injectCitations } from "./injector.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";
import { makeDocx, para, zcite, readDocumentXml, tempDir, TempDir } from "../../test/helpers/fixtures.js";

const TEST_USER_ID = "12345";

/** Dati Zotero di default (l'injector converte in CSL internamente). */
const defaultZoteroData = {
  itemType: "journalArticle",
  title: "Test Paper",
  creators: [{ firstName: "John", lastName: "Smith", creatorType: "author" }],
  date: "2023",
};

/** Fake API Zotero: serve `library` per chiave, 404 (ZoteroApiError) per chiavi assenti. */
function fakeApi(library: Record<string, Record<string, unknown>>): ZoteroApiInterface {
  let pendingKey: string | undefined;
  const make = (): ZoteroApiInterface =>
    ({
      library: () => make(),
      collections: () => make(),
      items: (key?: string) => {
        if (key !== undefined) pendingKey = key;
        return make();
      },
      children: () => make(),
      top: () => make(),
      trash: () => make(),
      version: () => make(),
      async get() {
        const data = library[pendingKey!];
        if (!data) {
          const err = new Error("not found") as Error & { response: { status: number } };
          err.response = { status: 404 };
          throw err;
        }
        return { getData: () => data, getVersion: () => 1, getTotalResults: () => null };
      },
      post: async () => {
        throw new Error("unsupported");
      },
      delete: async () => {
        throw new Error("unsupported");
      },
    }) as unknown as ZoteroApiInterface;
  return make();
}

const SMITH = { SMITH222: defaultZoteroData };

describe("injectCitations", () => {
  let dir: TempDir;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await dir.cleanup();
  });

  async function run(body: string, library: Record<string, Record<string, unknown>>, style = "apa") {
    const input = await dir.file("test.docx", await makeDocx(body));
    const result = await injectCitations(input, fakeApi(library), "user", TEST_USER_ID, style);
    const xml = await readDocumentXml(await readFile(result.outputPath));
    return { result, xml };
  }

  it("replaces a single <zcite> tag with field code", async () => {
    const { result, xml } = await run(para("Some text ", zcite({ keys: "SMITH222" }), " more text"), SMITH);
    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
    expect(result.outputPath).toMatch(/test_cited\.docx$/);
    expect(xml).toContain("ADDIN ZOTERO_ITEM");
    expect(xml).toContain("ZOTERO_BIBL");
  });

  it("handles multiple zcite tags in one document", async () => {
    const { result } = await run(
      para(zcite({ keys: "SMITH222" })) + para(zcite({ keys: "DEFG2345" })),
      { SMITH222: defaultZoteroData, DEFG2345: defaultZoteroData }
    );
    expect(result.found).toBe(2);
    expect(result.injected).toBe(2);
  });

  it('handles multi-citation tag <zcite keys="ABC,DEF"/>', async () => {
    const { result } = await run(para(zcite({ keys: "SMITH222,DEFG2345" })), {
      SMITH222: defaultZoteroData,
      DEFG2345: defaultZoteroData,
    });
    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
  });

  it("handles tag with locator attribute", async () => {
    const { result, xml } = await run(para(zcite({ keys: "SMITH222", locator: "pp. 12-15" })), SMITH);
    expect(result.injected).toBe(1);
    expect(xml).toContain("pp. 12-15");
  });

  it("handles tag with prefix and suffix attributes", async () => {
    const { result, xml } = await run(
      para(zcite({ keys: "SMITH222", prefix: "see ", suffix: ", emphasis added" })),
      SMITH
    );
    expect(result.injected).toBe(1);
    expect(xml).toContain("see ");
    expect(xml).toContain("emphasis added");
  });

  it("returns unchanged file when no zcite tags found", async () => {
    const { result } = await run(para("Plain text"), {});
    expect(result.found).toBe(0);
    expect(result.injected).toBe(0);
  });

  it("appends bibliography before </w:body>", async () => {
    const { xml } = await run(para(zcite({ keys: "SMITH222" })), SMITH);
    expect(xml).toMatch(/ZOTERO_BIBL[\s\S]*<\/w:body>/);
  });

  it("handles tag with num attribute for numeric styles", async () => {
    const { result, xml } = await run(para(zcite({ keys: "SMITH222", num: "1" })), SMITH, "ieee");
    expect(result.injected).toBe(1);
    expect(xml).toContain("[1]");
  });

  it("warns when vancouver style tags are missing num attribute", async () => {
    const { result } = await run(
      para(zcite({ keys: "SMITH222" })) + para(zcite({ keys: "DEFG2345" })),
      { SMITH222: defaultZoteroData, DEFG2345: defaultZoteroData },
      "vancouver"
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("vancouver");
    expect(result.warnings[0]).toContain("0/2");
  });

  it("no warnings when all vancouver tags have num", async () => {
    const { result } = await run(
      para(zcite({ keys: "SMITH222", num: "1" })) + para(zcite({ keys: "DEFG2345", num: "2" })),
      { SMITH222: defaultZoteroData, DEFG2345: defaultZoteroData },
      "vancouver"
    );
    expect(result.warnings).toHaveLength(0);
  });

  it("no warnings for apa style regardless of num", async () => {
    const { result } = await run(para(zcite({ keys: "SMITH222" })), SMITH);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles minified XML without matching across runs", async () => {
    // Regressione: XML minificato con più <w:rPr>; la run dello zcite ha anch'essa <w:rPr>.
    const body =
      "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r>" +
      "<w:r><w:rPr><w:i/></w:rPr><w:t>Subtitle</w:t></w:r>" +
      '<w:r><w:rPr><w:noProof/></w:rPr><w:t>&lt;zcite keys=&quot;SMITH222&quot;/&gt;</w:t></w:r></w:p>';
    const { result, xml } = await run(body, SMITH);
    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
    expect(xml).toContain("<w:t>Title</w:t>");
    expect(xml).toContain("<w:t>Subtitle</w:t>");
    expect(xml).toContain("ADDIN ZOTERO_ITEM");
  });

  it("handles attributes in non-standard order (num before keys)", async () => {
    const body = '<w:p><w:r><w:t>&lt;zcite num=&quot;1&quot; keys=&quot;SMITH222&quot;/&gt;</w:t></w:r></w:p>';
    const { result, xml } = await run(body, SMITH, "ieee");
    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
    expect(xml).toContain("[1]");
    expect(xml).toContain("ADDIN ZOTERO_ITEM");
  });

  it("handles XML entity in attribute value (&amp; in locator)", async () => {
    const body =
      '<w:p><w:r><w:t>&lt;zcite keys=&quot;SMITH222&quot; locator=&quot;pp. 12 &amp;amp; 15&quot;/&gt;</w:t></w:r></w:p>';
    const { result, xml } = await run(body, SMITH);
    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
    expect(xml).toContain("pp. 12 &amp; 15");
  });

  it("handles zcite split across runs (integration)", async () => {
    const body =
      "<w:p>" +
      '<w:r><w:rPr><w:lang w:val="en-US"/></w:rPr><w:t>&lt;zcite keys=&quot;SM</w:t></w:r>' +
      '<w:r><w:rPr><w:lang w:val="it-IT"/></w:rPr><w:t>ITH222&quot;/&gt;</w:t></w:r>' +
      "</w:p>";
    const { result, xml } = await run(body, SMITH);
    expect(result.found).toBe(1);
    expect(result.injected).toBe(1);
    expect(xml).toContain("ADDIN ZOTERO_ITEM");
  });

  it("throws on invalid docx (no word/document.xml)", async () => {
    const input = await dir.file("bad.docx", await makeDocx("", { omitDocument: true }));
    await expect(injectCitations(input, fakeApi({}), "user", TEST_USER_ID, "apa")).rejects.toThrow(
      "Invalid .docx file: word/document.xml not found"
    );
  });
});
