import { describe, it, expect } from "vitest";
import { formatCreators, formatTags } from "./item-formatter.js";

describe("formatCreators", () => {
  it("formats creators with first and last names", () => {
    const creators = [
      { firstName: "John", lastName: "Smith", creatorType: "author" },
      { firstName: "Jane", lastName: "Doe", creatorType: "author" },
    ];
    expect(formatCreators(creators)).toBe("John Smith, Jane Doe");
  });

  it("uses the single-field name of institutional creators", () => {
    const creators = [{ name: "Test Consortium", creatorType: "author" }, { firstName: "Jane", lastName: "Doe", creatorType: "author" }];
    expect(formatCreators(creators)).toBe("Test Consortium, Jane Doe");
  });

  it("handles creators with only lastName", () => {
    const creators = [{ lastName: "Smith", creatorType: "author" }];
    expect(formatCreators(creators)).toBe("Smith");
  });

  it("handles creators with only firstName", () => {
    const creators = [{ firstName: "John", creatorType: "author" }];
    expect(formatCreators(creators)).toBe("John");
  });

  it("returns fallback for undefined creators", () => {
    expect(formatCreators(undefined)).toBe("No authors listed");
  });

  it("returns fallback for empty array", () => {
    expect(formatCreators([])).toBe("No authors listed");
  });
});

describe("formatTags", () => {
  it("extracts tag strings from tag objects", () => {
    const tags = [{ tag: "deep-learning" }, { tag: "NLP" }];
    expect(formatTags(tags)).toEqual(["deep-learning", "NLP"]);
  });

  it("returns empty array for undefined tags", () => {
    expect(formatTags(undefined)).toEqual([]);
  });

  it("returns empty array for empty array", () => {
    expect(formatTags([])).toEqual([]);
  });
});
