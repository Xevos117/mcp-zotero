import { describe, it, expect } from "vitest";
import { cslDate, cslToZoteroItem, zoteroItemToCsl } from "./csl-to-zotero.js";
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

  it("maps editors and other CSL name roles to Zotero creator types valid for the item type", () => {
    const result = cslToZoteroItem({
      type: "chapter",
      title: "A Chapter",
      author: [{ family: "Gamma", given: "Gina" }],
      editor: [{ family: "Gialli", given: "Ugo" }],
      "collection-editor": [{ family: "Serie", given: "Sara" }],
      "container-author": [{ family: "Boss", given: "Bo" }],
      translator: [{ family: "Trad", given: "T" }],
    });
    expect(result.creators).toEqual([
      { firstName: "Gina", lastName: "Gamma", creatorType: "author" },
      { firstName: "Ugo", lastName: "Gialli", creatorType: "editor" },
      { firstName: "Bo", lastName: "Boss", creatorType: "bookAuthor" },
      { firstName: "Sara", lastName: "Serie", creatorType: "seriesEditor" },
      { firstName: "T", lastName: "Trad", creatorType: "translator" },
    ]);
  });

  it("drops name roles the item type does not have (the API would reject the item)", () => {
    const result = cslToZoteroItem({
      type: "article-journal",
      author: [{ family: "Smith", given: "J" }],
      editor: [{ family: "Ed", given: "E" }],
      "collection-editor": [{ family: "Series", given: "S" }],
      "container-author": [{ family: "Boss", given: "B" }],
    });
    expect(result.creators).toEqual([
      { firstName: "J", lastName: "Smith", creatorType: "author" },
      { firstName: "E", lastName: "Ed", creatorType: "editor" },
    ]);
  });

  it("maps a CSL literal name (institution) to Zotero's single-field name", () => {
    const result = cslToZoteroItem({
      type: "report",
      author: [{ literal: "RDA FAIR Data Maturity Model Working Group" }, { family: "Doe", given: "Jane" }],
    });
    expect(result.creators).toEqual([
      { name: "RDA FAIR Data Maturity Model Working Group", creatorType: "author" },
      { firstName: "Jane", lastName: "Doe", creatorType: "author" },
    ]);
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

describe("cslToZoteroItem: fields of the DOI import (#50)", () => {
  it("container-title-short → journalAbbreviation; subtitle joined to the title with \": \"", () => {
    const r = cslToZoteroItem({ type: "journal-article", title: "Main", subtitle: ["Sub"], "container-title": "J", "container-title-short": "J. Abbr." });
    expect(r).toMatchObject({ title: "Main: Sub", journalAbbreviation: "J. Abbr." });
    expect(cslToZoteroItem({ type: "book", title: "Main", subtitle: "Sub" }).title).toBe("Main: Sub");
    expect(cslToZoteroItem({ type: "book", title: "Main", subtitle: [] }).title).toBe("Main");
    // a type without the field (book) drops it
    expect(cslToZoteroItem({ type: "book", title: "B", "container-title-short": "X" })).not.toHaveProperty("journalAbbreviation");
  });

  it("event-title / event → conferenceName (event-title first)", () => {
    expect(cslToZoteroItem({ type: "proceedings-article", title: "P", event: "Old" }).conferenceName).toBe("Old");
    expect(cslToZoteroItem({ type: "proceedings-article", title: "P", event: "Old", "event-title": "ACL 2020" }).conferenceName).toBe("ACL 2020");
    expect(cslToZoteroItem({ type: "journal-article", title: "J", event: "E" })).not.toHaveProperty("conferenceName");
  });

  it("number / article-number → reportNumber of a report; the pages of an article without pages", () => {
    expect(cslToZoteroItem({ type: "report", title: "R", number: "TR-7" }).reportNumber).toBe("TR-7");
    expect(cslToZoteroItem({ type: "report", title: "R", "article-number": "8" }).reportNumber).toBe("8");
    expect(cslToZoteroItem({ type: "journal-article", title: "J", "article-number": "1266725" }).pages).toBe("1266725");
    expect(cslToZoteroItem({ type: "journal-article", title: "J", page: "1-9", "article-number": "8" }).pages).toBe("1-9");
    const report = cslToZoteroItem({ type: "report", title: "R", "article-number": "8" });
    expect(report.pages).toBe("");
  });

  it("publisher → university / institution / repository for thesis / report / preprint", () => {
    expect(cslToZoteroItem({ type: "thesis", title: "T", publisher: "Uni" })).toMatchObject({ university: "Uni" });
    expect(cslToZoteroItem({ type: "report", title: "R", publisher: "Inst" })).toMatchObject({ institution: "Inst" });
    expect(cslToZoteroItem({ type: "posted-content", title: "P", publisher: "bioRxiv" })).toMatchObject({ itemType: "preprint", repository: "bioRxiv" });
    expect(cslToZoteroItem({ type: "thesis", title: "T", publisher: "Uni" })).not.toHaveProperty("publisher");
  });

  it("JATS tags of the abstract removed, one line per paragraph; plain abstracts unchanged", () => {
    const abstract = "<jats:title>Abstract</jats:title><jats:p>First <jats:italic>in</jats:italic>  part.</jats:p>\n  <jats:p>Second &lt; 3.</jats:p>";
    expect(cslToZoteroItem({ type: "journal-article", title: "J", abstract }).abstractNote).toBe("Abstract First in part.\nSecond &lt; 3.");
    expect(cslToZoteroItem({ type: "journal-article", title: "J", abstract: "Plain <b>text</b>" }).abstractNote).toBe("Plain <b>text</b>");
  });

  it("arXiv DOI (10.48550/arXiv.*) → preprint, repository arXiv, archiveID arXiv:<id>", () => {
    const r = cslToZoteroItem({ type: "article", title: "Mistral 7B", DOI: "10.48550/arXiv.2310.06825", publisher: "arXiv", "container-title": "x" });
    expect(r).toMatchObject({ itemType: "preprint", repository: "arXiv", archiveID: "arXiv:2310.06825", DOI: "10.48550/arXiv.2310.06825" });
    expect(r).not.toHaveProperty("publicationTitle");
    expect(cslToZoteroItem({ type: "article", title: "A", DOI: "10.48550/ARXIV.2101.00001" }).archiveID).toBe("arXiv:2101.00001");
    expect(cslToZoteroItem({ type: "article", title: "A", DOI: "10.1000/arXiv.2101" }).itemType).toBe("journalArticle");
  });

  it("every new field still passes the type filter (ITEM_TYPE_FIELDS)", () => {
    const csl: CslItemData = { type: "report", title: "R", subtitle: ["S"], "container-title-short": "C", event: "E", number: "1", publisher: "I", abstract: "<jats:p>A</jats:p>" };
    for (const type of ["report", "thesis", "journal-article", "proceedings-article", "posted-content", "book"]) {
      const r = cslToZoteroItem({ ...csl, type });
      const valid = ITEM_TYPE_FIELDS[r.itemType as ZoteroItemType];
      for (const k of Object.keys(r)) if (!["itemType", "creators", "collections", "tags"].includes(k)) expect(valid.has(k), `${type}: ${k}`).toBe(true);
    }
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

  it("drops empty-string fields (the API sends every field of the type)", () => {
    const result = zoteroItemToCsl({ itemType: "book", title: "B", DOI: "", url: "", issue: "", pages: "", place: "", publisher: "P" });
    expect(JSON.parse(JSON.stringify(result))).toEqual({ type: "book", title: "B", publisher: "P" });
  });

  it("carries volume/issue/page/publisher/place and omits the abstract", () => {
    const result = zoteroItemToCsl({
      itemType: "journalArticle",
      title: "Full",
      volume: "12",
      issue: "10",
      pages: "1-9",
      publisher: "PLOS",
      place: "San Francisco",
      abstractNote: "Long abstract",
    });
    expect(result).toMatchObject({ volume: "12", issue: "10", page: "1-9", publisher: "PLOS", "publisher-place": "San Francisco" });
    expect(result).not.toHaveProperty("abstract");
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

  it("maps creators by role: authors, editors, series editors, book authors, translators; others dropped", () => {
    const result = zoteroItemToCsl({
      creators: [
        { firstName: "John", lastName: "Smith", creatorType: "author" },
        { firstName: "Jane", lastName: "Doe", creatorType: "editor" },
        { firstName: "Sara", lastName: "Serie", creatorType: "seriesEditor" },
        { firstName: "Bo", lastName: "Boss", creatorType: "bookAuthor" },
        { firstName: "T", lastName: "Trad", creatorType: "translator" },
        { firstName: "C", lastName: "Contrib", creatorType: "contributor" },
      ],
    });
    expect(result.author).toEqual([{ family: "Smith", given: "John" }]);
    expect(result.editor).toEqual([{ family: "Doe", given: "Jane" }]);
    expect(result["collection-editor"]).toEqual([{ family: "Serie", given: "Sara" }]);
    expect(result["container-author"]).toEqual([{ family: "Boss", given: "Bo" }]);
    expect(result.translator).toEqual([{ family: "Trad", given: "T" }]);
    expect(JSON.stringify(result)).not.toContain("Contrib");
  });

  it("single-field name (institution) → CSL literal, not a family name", () => {
    const result = zoteroItemToCsl({ itemType: "report", creators: [{ name: "Test Consortium", creatorType: "author" }] });
    expect(result.author).toEqual([{ literal: "Test Consortium" }]);
  });

  it.each([
    ["bookSection", "bookTitle"],
    ["conferencePaper", "proceedingsTitle"],
    ["encyclopediaArticle", "encyclopediaTitle"],
    ["dictionaryEntry", "dictionaryTitle"],
    ["blogPost", "blogTitle"],
    ["forumPost", "forumTitle"],
    ["webpage", "websiteTitle"],
    ["tvBroadcast", "programTitle"],
    ["journalArticle", "publicationTitle"],
  ])("container-title from the %s field %s", (itemType, field) => {
    expect(zoteroItemToCsl({ itemType, [field]: "The Container" } as never)["container-title"]).toBe("The Container");
  });

  it("container-title falls back to publicationTitle and stays out when empty", () => {
    expect(zoteroItemToCsl({ itemType: "bookSection", bookTitle: "", publicationTitle: "P" } as never)["container-title"]).toBe("P");
    expect(zoteroItemToCsl({ itemType: "bookSection", bookTitle: "" } as never)).not.toHaveProperty("container-title", expect.anything());
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

describe("zoteroItemToCsl: fields of the embedded itemData (#50)", () => {
  it("thesis: university → publisher, thesisType → genre; report: institution, reportNumber, reportType", () => {
    expect(zoteroItemToCsl({ itemType: "thesis", title: "T", university: "University of Bologna", thesisType: "PhD thesis" } as never)).toMatchObject({
      type: "thesis",
      publisher: "University of Bologna",
      genre: "PhD thesis",
    });
    expect(zoteroItemToCsl({ itemType: "report", title: "R", institution: "RDA", reportNumber: "50", reportType: "Specification" } as never)).toMatchObject({
      type: "report",
      publisher: "RDA",
      number: "50",
      genre: "Specification",
    });
  });

  it("preprint: repository → publisher, archiveID → number", () => {
    expect(zoteroItemToCsl({ itemType: "preprint", title: "P", repository: "arXiv", archiveID: "arXiv:2310.06825" } as never)).toMatchObject({
      type: "article",
      publisher: "arXiv",
      number: "arXiv:2310.06825",
    });
  });

  it("accessDate → accessed (the day only, ISO or Zotero's SQL form)", () => {
    expect(zoteroItemToCsl({ itemType: "webpage", accessDate: "2026-10-21T08:00:00Z" } as never).accessed).toEqual({ "date-parts": [[2026, 10, 21]] });
    expect(zoteroItemToCsl({ itemType: "webpage", accessDate: "2026-10-21 08:00:00" } as never).accessed).toEqual({ "date-parts": [[2026, 10, 21]] });
    expect(zoteroItemToCsl({ itemType: "webpage", accessDate: "" } as never)).not.toHaveProperty("accessed", expect.anything());
  });

  it("ISBN, ISSN, edition, language, numPages → number-of-pages", () => {
    expect(zoteroItemToCsl({ itemType: "book", title: "B", ISBN: "978-1", ISSN: "1234-5678", edition: "2", language: "it", numPages: "300" } as never)).toMatchObject({
      ISBN: "978-1",
      ISSN: "1234-5678",
      edition: "2",
      language: "it",
      "number-of-pages": "300",
    });
  });

  it("a date that is not YYYY-MM-DD → issued.raw (citeproc parses it), never dropped", () => {
    expect(zoteroItemToCsl({ date: "October 2023" }).issued).toEqual({ raw: "October 2023" });
    expect(zoteroItemToCsl({ date: "2023-10" }).issued).toEqual({ "date-parts": [[2023, 10]] });
    expect(cslDate("")).toBeUndefined();
  });

  it("empty or missing fields stay out of the field code", () => {
    const r = zoteroItemToCsl({ itemType: "thesis", title: "T", university: "", thesisType: "", accessDate: "", ISBN: "" } as never);
    expect(JSON.parse(JSON.stringify(r))).toEqual({ type: "thesis", title: "T" });
  });
});
