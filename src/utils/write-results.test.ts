import { describe, it, expect } from "vitest";
import { formatWriteError, formatWriteErrors } from "./write-results.js";

describe("formatWriteError", () => {
  it("formats code and message", () => {
    expect(formatWriteError({ key: "", code: 400, message: "Invalid date" })).toBe("400: Invalid date");
  });

  it("mentions the key when the server reports one", () => {
    expect(formatWriteError({ key: "ABCD1234", code: 412, message: "Item has been modified" })).toBe(
      "412: Item has been modified (key ABCD1234)"
    );
  });

  it("keeps plain strings and falls back to JSON for unknown shapes", () => {
    expect(formatWriteError("boom")).toBe("boom");
    expect(formatWriteError({})).toBe("{}");
  });
});

describe("formatWriteErrors", () => {
  it("joins all errors and never yields [object Object]", () => {
    const text = formatWriteErrors({ 0: { code: 400, message: "A" }, 2: { code: 413, message: "B" } });
    expect(text).toBe("400: A; 413: B");
  });

  it("returns 'Unknown error' when there are none", () => {
    expect(formatWriteErrors({})).toBe("Unknown error");
  });
});
