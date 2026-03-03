import { describe, it, expect } from "vitest";
import { cslToZoteroItem, zoteroItemToCsl } from "./csl-to-zotero.js";
import { CslItemData } from "../types/csl-types.js";
import { ITEM_TYPE_FIELDS, ZoteroItemType } from "./zotero-item-types.js";

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

  it("maps non-standard CrossRef/DataCite types correctly", () => {
    const testCases: Array<{ cslType: string; expectedZoteroType: string }> = [
      { cslType: "journal-article", expectedZoteroType: "journalArticle" },
      { cslType: "book-chapter", expectedZoteroType: "bookSection" },
      { cslType: "proceedings-article", expectedZoteroType: "conferencePaper" },
      { cslType: "posted-content", expectedZoteroType: "preprint" },
      { cslType: "dissertation", expectedZoteroType: "thesis" },
      { cslType: "monograph", expectedZoteroType: "book" },
      { cslType: "reference-entry", expectedZoteroType: "encyclopediaArticle" },
      { cslType: "edited-book", expectedZoteroType: "book" },
      { cslType: "book-part", expectedZoteroType: "bookSection" },
      { cslType: "proceedings", expectedZoteroType: "book" },
      { cslType: "report-series", expectedZoteroType: "report" },
    ];

    for (const { cslType, expectedZoteroType } of testCases) {
      const result = cslToZoteroItem({ type: cslType });
      expect(result.itemType, `${cslType} should map to ${expectedZoteroType}`).toBe(expectedZoteroType);
    }
  });

  it("maps book-chapter container-title to bookTitle", () => {
    const result = cslToZoteroItem({
      type: "book-chapter",
      title: "A Chapter",
      "container-title": "The Book",
    });
    expect(result.itemType).toBe("bookSection");
    expect(result.bookTitle).toBe("The Book");
    expect(result).not.toHaveProperty("publicationTitle");
  });

  it("maps proceedings-article container-title to proceedingsTitle", () => {
    const result = cslToZoteroItem({
      type: "proceedings-article",
      title: "A Paper",
      "container-title": "Conference 2024",
    });
    expect(result.itemType).toBe("conferencePaper");
    expect(result.proceedingsTitle).toBe("Conference 2024");
    expect(result).not.toHaveProperty("publicationTitle");
  });

  it("handles ISBN and ISSN as arrays (DOI resolver can return arrays)", () => {
    const csl: CslItemData = {
      type: "book",
      title: "Array ISBN Book",
      ISSN: ["1234-5678", "8765-4321"] as unknown as string,
      ISBN: ["978-0-123456-78-9"] as unknown as string,
    };

    const result = cslToZoteroItem(csl);
    expect(result.ISSN).toBe("1234-5678");
    expect(result.ISBN).toBe("978-0-123456-78-9");
  });

  it("handles ISBN and ISSN as strings (normal case)", () => {
    const csl: CslItemData = {
      type: "book",
      title: "String ISBN Book",
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

  describe("container-title mapping", () => {
    it("maps container-title to bookTitle for bookSection", () => {
      const result = cslToZoteroItem({
        type: "chapter",
        title: "A Chapter",
        "container-title": "The Parent Book",
      });
      expect(result.itemType).toBe("bookSection");
      expect(result.bookTitle).toBe("The Parent Book");
      expect(result).not.toHaveProperty("publicationTitle");
    });

    it("maps container-title to proceedingsTitle for conferencePaper", () => {
      const result = cslToZoteroItem({
        type: "paper-conference",
        title: "A Paper",
        "container-title": "Conf Proceedings 2024",
      });
      expect(result.itemType).toBe("conferencePaper");
      expect(result.proceedingsTitle).toBe("Conf Proceedings 2024");
      expect(result).not.toHaveProperty("publicationTitle");
    });

    it("maps container-title to blogTitle for blogPost", () => {
      const result = cslToZoteroItem({
        type: "post-weblog",
        title: "A Post",
        "container-title": "My Blog",
      });
      expect(result.blogTitle).toBe("My Blog");
    });

    it("maps container-title to encyclopediaTitle for encyclopediaArticle", () => {
      const result = cslToZoteroItem({
        type: "entry-encyclopedia",
        title: "An Entry",
        "container-title": "Encyclopedia Britannica",
      });
      expect(result.encyclopediaTitle).toBe("Encyclopedia Britannica");
    });

    it("maps container-title to dictionaryTitle for dictionaryEntry", () => {
      const result = cslToZoteroItem({
        type: "entry-dictionary",
        title: "A Word",
        "container-title": "Oxford Dictionary",
      });
      expect(result.dictionaryTitle).toBe("Oxford Dictionary");
    });

    it("maps container-title to programTitle for tvBroadcast", () => {
      const result = cslToZoteroItem({
        type: "broadcast",
        title: "An Episode",
        "container-title": "The Show",
      });
      expect(result.programTitle).toBe("The Show");
    });

    it("maps container-title to websiteTitle for webpage", () => {
      const result = cslToZoteroItem({
        type: "webpage",
        title: "A Page",
        "container-title": "Example.com",
      });
      expect(result.websiteTitle).toBe("Example.com");
    });

    it("does not add container-title field for types without mapping (book)", () => {
      const result = cslToZoteroItem({
        type: "book",
        title: "A Book",
        "container-title": "Should Be Ignored",
      });
      expect(result).not.toHaveProperty("publicationTitle");
      expect(result).not.toHaveProperty("bookTitle");
    });
  });

  describe("field filtering by item type", () => {
    it("excludes publicationTitle from book output", () => {
      const result = cslToZoteroItem({
        type: "book",
        title: "A Book",
      });
      expect(result).not.toHaveProperty("publicationTitle");
    });

    it("excludes ISBN from journalArticle output", () => {
      const result = cslToZoteroItem({
        type: "article-journal",
        title: "A Paper",
        ISBN: "978-0-123456-78-9",
      });
      expect(result).not.toHaveProperty("ISBN");
    });

    it("includes ISBN for book (valid field)", () => {
      const result = cslToZoteroItem({
        type: "book",
        title: "A Book",
        ISBN: "978-0-123456-78-9",
      });
      expect(result.ISBN).toBe("978-0-123456-78-9");
    });

    it("excludes volume and issue from book output", () => {
      const result = cslToZoteroItem({
        type: "book",
        title: "A Book",
        volume: "1",
        issue: "2",
      });
      expect(result.volume).toBe("1"); // volume is valid for book
      expect(result).not.toHaveProperty("issue"); // issue is NOT valid for book
    });

    it("all returned data fields are valid for the item type", () => {
      const csl: CslItemData = {
        type: "article-journal",
        title: "Comprehensive Paper",
        author: [{ family: "Smith", given: "John" }],
        DOI: "10.1234/test",
        "container-title": "Test Journal",
        volume: "42",
        issue: "3",
        page: "100-120",
        publisher: "Publisher",
        "publisher-place": "Place",
        URL: "https://example.com",
        abstract: "Abstract text",
        ISBN: "978-0-123456-78-9",
        ISSN: "1234-5678",
        edition: "2nd",
        "number-of-pages": "350",
        "collection-title": "Series",
        language: "en",
      };

      const result = cslToZoteroItem(csl);
      const validFields = ITEM_TYPE_FIELDS["journalArticle"];
      const structuralFields = new Set(["itemType", "creators", "collections", "tags"]);

      for (const key of Object.keys(result)) {
        if (!structuralFields.has(key)) {
          expect(validFields.has(key), `field "${key}" should be valid for journalArticle`).toBe(true);
        }
      }
    });

    it("filters fields for multiple item types correctly", () => {
      const types: Array<{ cslType: string; zoteroType: ZoteroItemType }> = [
        { cslType: "book", zoteroType: "book" },
        { cslType: "thesis", zoteroType: "thesis" },
        { cslType: "report", zoteroType: "report" },
        { cslType: "patent", zoteroType: "patent" },
        { cslType: "webpage", zoteroType: "webpage" },
      ];

      for (const { cslType, zoteroType } of types) {
        const result = cslToZoteroItem({
          type: cslType,
          title: "Test",
          ISBN: "978-0-123456-78-9",
          ISSN: "1234-5678",
          volume: "1",
          issue: "2",
          page: "10-20",
        });

        const validFields = ITEM_TYPE_FIELDS[zoteroType];
        const structuralFields = new Set(["itemType", "creators", "collections", "tags"]);

        for (const key of Object.keys(result)) {
          if (!structuralFields.has(key)) {
            expect(
              validFields.has(key),
              `field "${key}" should be valid for ${zoteroType}`
            ).toBe(true);
          }
        }
      }
    });
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
