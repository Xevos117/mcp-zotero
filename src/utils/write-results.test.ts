import { describe, it, expect } from "vitest";
import { formatWriteError, formatWriteErrors, postInBatches } from "./write-results.js";

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

describe("postInBatches", () => {
  const response = (n: number, errors: Record<number, unknown> = {}) => ({
    isSuccess: () => Object.keys(errors).length === 0,
    getErrors: () => errors as Record<string, never>,
    getData: () => Array.from({ length: n }, (_, i) => (i in errors ? {} : { key: `K${i}` })),
    getEntityByIndex: () => ({}),
  });

  it("marks a throwing batch as failed but keeps the batches already written", async () => {
    const payloads = Array.from({ length: 60 }, (_, i) => ({ i }));
    let call = 0;
    const result = await postInBatches(async (batch) => {
      if (call++ === 1) throw new Error("HTTP 429");
      return response(batch.length);
    }, payloads);
    expect(result.created).toHaveLength(50);
    expect(result.failed.map((f) => f.index)).toEqual(Array.from({ length: 10 }, (_, i) => 50 + i));
    expect(result.failed[0].error).toBe("HTTP 429");
  });

  it("rethrows when nothing was written at all", async () => {
    await expect(postInBatches(async () => { throw new Error("HTTP 403"); }, [{}, {}])).rejects.toThrow("HTTP 403");
  });

  it("treats a success without key as failed", async () => {
    const result = await postInBatches(async () => ({ ...response(1), getData: () => [{}] }), [{}]);
    expect(result.failed).toEqual([{ index: 0, error: "Zotero response did not include an item key" }]);
  });
});
