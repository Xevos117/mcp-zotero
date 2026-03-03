import { describe, it, expect } from "vitest";
import { cslToZoteroItem, zoteroItemToCsl } from "./csl-to-zotero.js";
import { CslItemData } from "../types/csl-types.js";

describe("cslToZoteroItem", () => {
  it("converts article-journal to journalArticle", () => {
    const csl: CslItemData = {
      type: "article-journal",
      title: "Test Paper",
      author: [{ family: "Smith", given: "John" }],
      issued: { "date-parts": [["2023"]] },
      DOI: "10.1234/test",
      "container-title": "Test Journal",
      volume: "42",
      issue: "3",
      page: "100-120",
    };

    const result = cslToZoteroItem(csl);
    expect(result.itemType).toBe("journalArticle");
    expect(result.title).toBe("Test Paper");
    expect(result.DOI).toBe("10.1234/test");
    expect(result.publicationTitle).toBe("Test Journal");
    expect(result.volume).toBe("42");
    expect(result.issue).toBe("3");
    expect(result.pages).toBe("100-120");
    expect(result.date).toBe("2023");
    expect(result.creators).toEqual([
      { firstName: "John", lastName: "Smith", creatorType: "author" },
    ]);
  });

  it("converts book to book", () => {
    const csl: CslItemData = {
      type: "book",
      title: "A Great Book",
      publisher: "Test Publisher",
      "publisher-place": "New York",
    };

    const result = cslToZoteroItem(csl);
    expect(result.itemType).toBe("book");
    expect(result.publisher).toBe("Test Publisher");
    expect(result.place).toBe("New York");
  });

  it("defaults unknown type to journalArticle", () => {
    const csl: CslItemData = {
      type: "unknown-type",
      title: "Mystery Item",
    };

    const result = cslToZoteroItem(csl);
    expect(result.itemType).toBe("journalArticle");
  });

  it("adds collectionKey and tags when specified", () => {
    const csl: CslItemData = {
      type: "article-journal",
      title: "Tagged Paper",
    };

    const result = cslToZoteroItem(csl, {
      collectionKey: "COL001",
      tags: ["ai", "nlp"],
    });
    expect(result.collections).toEqual(["COL001"]);
    expect(result.tags).toEqual([{ tag: "ai" }, { tag: "nlp" }]);
  });

  it("handles missing optional fields gracefully", () => {
    const csl: CslItemData = {
      type: "article-journal",
    };

    const result = cslToZoteroItem(csl);
    expect(result.title).toBe("");
    expect(result.creators).toEqual([]);
    expect(result.date).toBe("");
    expect(result.DOI).toBe("");
    expect(result.publicationTitle).toBe("");
  });

  it("maps new CSL types correctly", () => {
    const testCases: Array<{ cslType: string; expectedZoteroType: string }> = [
      { cslType: "article-magazine", expectedZoteroType: "magazineArticle" },
      { cslType: "article-newspaper", expectedZoteroType: "newspaperArticle" },
      { cslType: "motion_picture", expectedZoteroType: "film" },
      { cslType: "legal_case", expectedZoteroType: "case" },
      { cslType: "legislation", expectedZoteroType: "statute" },
      { cslType: "post-weblog", expectedZoteroType: "blogPost" },
      { cslType: "software", expectedZoteroType: "computerProgram" },
      { cslType: "song", expectedZoteroType: "audioRecording" },
      { cslType: "speech", expectedZoteroType: "presentation" },
      { cslType: "graphic", expectedZoteroType: "artwork" },
      { cslType: "personal_communication", expectedZoteroType: "letter" },
      { cslType: "broadcast", expectedZoteroType: "tvBroadcast" },
      { cslType: "entry-dictionary", expectedZoteroType: "dictionaryEntry" },
      { cslType: "entry-encyclopedia", expectedZoteroType: "encyclopediaArticle" },
      { cslType: "patent", expectedZoteroType: "patent" },
      { cslType: "manuscript", expectedZoteroType: "manuscript" },
      { cslType: "standard", expectedZoteroType: "standard" },
    ];

    for (const { cslType, expectedZoteroType } of testCases) {
      const result = cslToZoteroItem({ type: cslType });
      expect(result.itemType).toBe(expectedZoteroType);
    }
  });

  it("handles ISBN and ISSN as arrays (DOI resolver can return arrays)", () => {
    const csl: CslItemData = {
      type: "article-journal",
      title: "Array ISSN Paper",
      ISSN: ["1234-5678", "8765-4321"] as unknown as string,
      ISBN: ["978-0-123456-78-9"] as unknown as string,
    };

    const result = cslToZoteroItem(csl);
    expect(result.ISSN).toBe("1234-5678");
    expect(result.ISBN).toBe("978-0-123456-78-9");
  });

  it("handles ISBN and ISSN as strings (normal case)", () => {
    const csl: CslItemData = {
      type: "article-journal",
      title: "String ISSN Paper",
      ISSN: "1234-5678",
      ISBN: "978-0-123456-78-9",
    };

    const result = cslToZoteroItem(csl);
    expect(result.ISSN).toBe("1234-5678");
    expect(result.ISBN).toBe("978-0-123456-78-9");
  });

  it("maps new CSL fields (ISBN, ISSN, edition, numPages, series, language)", () => {
    const csl: CslItemData = {
      type: "book",
      title: "Test Book",
      ISBN: "978-0-123456-78-9",
      ISSN: "1234-5678",
      edition: "3rd",
      "number-of-pages": "350",
      "collection-title": "Test Series",
      language: "en",
    };

    const result = cslToZoteroItem(csl);
    expect(result.ISBN).toBe("978-0-123456-78-9");
    expect(result.ISSN).toBe("1234-5678");
    expect(result.edition).toBe("3rd");
    expect(result.numPages).toBe("350");
    expect(result.series).toBe("Test Series");
    expect(result.language).toBe("en");
  });
});

describe("zoteroItemToCsl", () => {
  it("converts journalArticle to article-journal", () => {
    const result = zoteroItemToCsl({
      itemType: "journalArticle",
      title: "Test Paper",
      creators: [
        { firstName: "John", lastName: "Smith", creatorType: "author" },
      ],
      date: "2023",
      DOI: "10.1234/test",
      publicationTitle: "Test Journal",
    });

    expect(result.type).toBe("article-journal");
    expect(result.title).toBe("Test Paper");
    expect(result.DOI).toBe("10.1234/test");
    expect(result["container-title"]).toBe("Test Journal");
    expect(result.author).toEqual([{ family: "Smith", given: "John" }]);
    expect(result.issued).toEqual({ "date-parts": [[2023]] });
  });

  it("converts book to book", () => {
    const result = zoteroItemToCsl({
      itemType: "book",
      title: "A Book",
    });
    expect(result.type).toBe("book");
  });

  it("defaults unknown type to article-journal", () => {
    const result = zoteroItemToCsl({
      itemType: "unknownType",
    });
    expect(result.type).toBe("article-journal");
  });

  it("parses multi-part date correctly", () => {
    const result = zoteroItemToCsl({
      date: "2023-06-15",
    });
    expect(result.issued).toEqual({ "date-parts": [[2023, 6, 15]] });
  });

  it("handles missing date", () => {
    const result = zoteroItemToCsl({});
    expect(result.issued).toBeUndefined();
  });

  it("handles missing creators", () => {
    const result = zoteroItemToCsl({});
    expect(result.author).toBeUndefined();
  });

  it("filters only authors from creators", () => {
    const result = zoteroItemToCsl({
      creators: [
        { firstName: "John", lastName: "Smith", creatorType: "author" },
        { firstName: "Jane", lastName: "Doe", creatorType: "editor" },
      ],
    });
    expect(result.author).toEqual([{ family: "Smith", given: "John" }]);
  });

  it("reverse-maps new Zotero types correctly", () => {
    const testCases: Array<{ zoteroType: string; expectedCslType: string }> = [
      { zoteroType: "magazineArticle", expectedCslType: "article-magazine" },
      { zoteroType: "newspaperArticle", expectedCslType: "article-newspaper" },
      { zoteroType: "film", expectedCslType: "motion_picture" },
      { zoteroType: "case", expectedCslType: "legal_case" },
      { zoteroType: "statute", expectedCslType: "legislation" },
      { zoteroType: "blogPost", expectedCslType: "post-weblog" },
      { zoteroType: "computerProgram", expectedCslType: "software" },
      { zoteroType: "audioRecording", expectedCslType: "song" },
      { zoteroType: "presentation", expectedCslType: "speech" },
      { zoteroType: "artwork", expectedCslType: "graphic" },
      { zoteroType: "letter", expectedCslType: "personal_communication" },
      { zoteroType: "dictionaryEntry", expectedCslType: "entry-dictionary" },
      { zoteroType: "encyclopediaArticle", expectedCslType: "entry-encyclopedia" },
      { zoteroType: "patent", expectedCslType: "patent" },
      { zoteroType: "manuscript", expectedCslType: "manuscript" },
      { zoteroType: "standard", expectedCslType: "standard" },
      { zoteroType: "preprint", expectedCslType: "article" },
    ];

    for (const { zoteroType, expectedCslType } of testCases) {
      const result = zoteroItemToCsl({ itemType: zoteroType });
      expect(result.type).toBe(expectedCslType);
    }
  });
});
