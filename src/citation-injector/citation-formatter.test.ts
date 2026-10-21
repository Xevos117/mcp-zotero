import { describe, it, expect } from "vitest";
import { formatCitationText, formatLocator } from "./citation-formatter.js";
import { CslItemData } from "../types/csl-types.js";

const singleAuthor: CslItemData = {
  type: "article-journal",
  author: [{ family: "Smith", given: "John" }],
  issued: { "date-parts": [["2023"]] },
};

const twoAuthors: CslItemData = {
  type: "article-journal",
  author: [
    { family: "Smith", given: "John" },
    { family: "Doe", given: "Jane" },
  ],
  issued: { "date-parts": [["2023"]] },
};

const threeAuthors: CslItemData = {
  type: "article-journal",
  author: [
    { family: "Smith", given: "John" },
    { family: "Doe", given: "Jane" },
    { family: "Brown", given: "Bob" },
  ],
  issued: { "date-parts": [["2023"]] },
};

describe("formatCitationText", () => {
  it("APA: single author → (Smith, 2023)", () => {
    expect(formatCitationText([singleAuthor], "apa")).toBe("(Smith, 2023)");
  });

  it("APA: two authors → (Smith & Doe, 2023)", () => {
    expect(formatCitationText([twoAuthors], "apa")).toBe(
      "(Smith & Doe, 2023)"
    );
  });

  it("APA: three+ authors → (Smith et al., 2023)", () => {
    expect(formatCitationText([threeAuthors], "apa")).toBe(
      "(Smith et al., 2023)"
    );
  });

  it("APA: multiple items → (Smith, 2023; Doe & Brown, ...)", () => {
    const item2: CslItemData = {
      type: "article-journal",
      author: [
        { family: "Doe", given: "Jane" },
        { family: "Brown", given: "Bob" },
      ],
      issued: { "date-parts": [["2024"]] },
    };
    expect(formatCitationText([singleAuthor, item2], "apa")).toBe(
      "(Smith, 2023; Doe & Brown, 2024)"
    );
  });

  it("IEEE → [?]", () => {
    expect(formatCitationText([singleAuthor], "ieee")).toBe("[?]");
  });

  it("Vancouver → [?]", () => {
    expect(formatCitationText([singleAuthor], "vancouver")).toBe("[?]");
  });

  it("missing author with title → uses abbreviated title", () => {
    const noAuthorWithTitle: CslItemData = {
      type: "article-journal",
      title: "A Short Title",
      issued: { "date-parts": [["2023"]] },
    };
    expect(formatCitationText([noAuthorWithTitle], "apa")).toBe(
      '("A Short Title", 2023)'
    );
  });

  it("missing author with long title → truncates at 30 chars", () => {
    const longTitle: CslItemData = {
      type: "article-journal",
      title: "A Very Long Title That Exceeds Thirty Characters Easily",
      issued: { "date-parts": [["2023"]] },
    };
    expect(formatCitationText([longTitle], "apa")).toBe(
      '("A Very Long Title That Exceeds...", 2023)'
    );
  });

  it("missing author and title → (Unknown, n.d.)", () => {
    const noAuthorDate: CslItemData = { type: "article-journal" };
    expect(formatCitationText([noAuthorDate], "apa")).toBe("(Unknown, n.d.)");
  });

  it('IEEE with num="1" → [1]', () => {
    expect(formatCitationText([singleAuthor], "ieee", { num: "1" })).toBe("[1]");
  });

  it('Vancouver with num="3" → [3]', () => {
    expect(formatCitationText([singleAuthor], "vancouver", { num: "3" })).toBe("[3]");
  });

  it("IEEE without num → [?]", () => {
    expect(formatCitationText([singleAuthor], "ieee")).toBe("[?]");
  });

  it("APA with num → ignores num, returns author-year", () => {
    expect(formatCitationText([singleAuthor], "apa", { num: "1" })).toBe(
      "(Smith, 2023)"
    );
  });

  // Expected strings are what citeproc renders with the CSL styles bundled with Zotero (test/fixtures/csl/)
  describe("locator, prefix and suffix per style", () => {
    const opts = { locator: "12", prefix: "see ", suffix: ", emphasis added" };
    it.each([
      ["apa", "(see Smith, 2023, p. 12, emphasis added)"],
      ["harvard", "(see Smith, 2023, p. 12, emphasis added)"],
      ["chicago", "(see Smith 2023, 12, emphasis added)"],
      ["ieee", "see [1, p. 12], emphasis added"],
      ["vancouver", "[see 1, emphasis added]"],
    ])("%s → %s", (style, expected) => {
      expect(formatCitationText([singleAuthor], style, { ...opts, num: "1" })).toBe(expected);
    });

    it.each([
      ["apa", "(Smith & Doe, 2023, pp. 12–15)"],
      ["harvard", "(Smith and Doe, 2023, pp. 12–15)"],
      ["chicago", "(Smith and Doe 2023, 12–15)"],
      ["ieee", "[1, pp. 12–15]"],
      ["vancouver", "[1]"],
    ])("locator range only, %s → %s", (style, expected) => {
      expect(formatCitationText([twoAuthors], style, { locator: "12-15", num: "1" })).toBe(expected);
    });

    it("prefix without space and suffix without punctuation are spaced like citeproc", () => {
      expect(formatCitationText([singleAuthor], "apa", { prefix: "see", suffix: "fig. 2" })).toBe("(see Smith, 2023 fig. 2)");
      expect(formatCitationText([singleAuthor], "ieee", { prefix: "see", suffix: "fig. 2", num: "1" })).toBe("see [1] fig. 2");
    });

    it("several keys: prefix/locator on every item (as in the field code); numbered styles split num per item", () => {
      const item2: CslItemData = { type: "book", author: [{ family: "Lee" }], issued: { "date-parts": [["2019"]] } };
      const o = { locator: "3", prefix: "cf." };
      expect(formatCitationText([singleAuthor, item2], "apa", o)).toBe("(cf. Smith, 2023, p. 3; cf. Lee, 2019, p. 3)");
      expect(formatCitationText([singleAuthor, item2], "ieee", { ...o, num: "1,2" })).toBe("cf. [1, p. 3], cf. [2, p. 3]");
      expect(formatCitationText([singleAuthor, item2], "ieee", { ...o, num: "1-2" })).toBe("cf. [1, p. 3], cf. [2, p. 3]");
      expect(formatCitationText([singleAuthor, item2], "vancouver", { ...o, num: "1,2" })).toBe("[cf. 1,cf. 2]");
      // num that does not match the keys: one group
      expect(formatCitationText([singleAuthor, item2], "ieee", { ...o, num: "1" })).toBe("cf. [1, p. 3]");
      expect(formatCitationText([singleAuthor], "ieee", { locator: "4" })).toBe("[?, p. 4]");
    });

    it("institutional (literal) author", () => {
      expect(formatCitationText([{ type: "report", author: [{ literal: "Test Consortium" }], issued: { "date-parts": [[2021]] } }], "apa", { locator: "4" })).toBe(
        "(Test Consortium, 2021, p. 4)"
      );
    });
  });

  describe("formatLocator", () => {
    it.each([
      ["12", true, "p. 12"],
      ["12-15", true, "pp. 12–15"],
      ["pp. 12-15", true, "pp. 12–15"],
      ["p.12", true, "p. 12"],
      ["12, 15", true, "pp. 12, 15"],
      ["xii", true, "p. xii"],
      ["12-15", false, "12–15"],
      ["pp. 12-15", false, "12–15"],
      ["chap. 3", true, "chap. 3"],
      ["fig. 2", false, "fig. 2"],
      ["§ 4", true, "§ 4"],
    ])("%s (page label %s) → %s", (locator, pageLabel, expected) => {
      expect(formatLocator(locator, pageLabel)).toBe(expected);
    });
  });
});
