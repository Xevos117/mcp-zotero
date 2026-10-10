import { describe, it, expect, vi } from "vitest";

vi.mock("unpdf", () => ({
  extractText: vi.fn(),
}));

import { extractPdfText } from "./pdf-text-extractor.js";
import { extractText } from "unpdf";

const extractTextMock = vi.mocked(extractText);

describe("extractPdfText", () => {
  it("extracts text from a PDF buffer", async () => {
    extractTextMock.mockResolvedValueOnce({
      totalPages: 5,
      text: "Hello world from PDF",
    });

    const buffer = Buffer.from("fake-pdf-bytes");
    const result = await extractPdfText(buffer);

    expect(result.text).toBe("Hello world from PDF");
    expect(result.totalPages).toBe(5);
    expect(extractTextMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      { mergePages: true }
    );
  });

  it("propagates errors from extractText", async () => {
    extractTextMock.mockRejectedValueOnce(new Error("Corrupt PDF"));

    const buffer = Buffer.from("not-a-pdf");
    await expect(extractPdfText(buffer)).rejects.toThrow("Corrupt PDF");
  });
});

describe("extractPdfText buffer ownership", () => {
  it("does not hand the caller's buffer to unpdf", async () => {
    extractTextMock.mockImplementationOnce(async (data) => {
      // Simulate unpdf detaching the ArrayBuffer it receives
      structuredClone((data as Uint8Array).buffer, { transfer: [(data as Uint8Array).buffer as ArrayBuffer] });
      return { totalPages: 1, text: "x" };
    });
    const buffer = Buffer.from("fake-pdf-bytes");
    await extractPdfText(buffer);
    expect(buffer.length).toBe(14);
  });
});
