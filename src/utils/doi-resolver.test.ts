import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveDoi, resolveDois } from "./doi-resolver.js";

const mockCslResponse = {
  type: "article-journal",
  title: "Attention Is All You Need",
  author: [
    { family: "Vaswani", given: "Ashish" },
    { family: "Shazeer", given: "Noam" },
  ],
  issued: { "date-parts": [["2017"]] },
  DOI: "10.48550/arXiv.1706.03762",
  "container-title": "Advances in Neural Information Processing Systems",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("resolveDoi", () => {
  it("resolves a DOI to CslItemData", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockCslResponse),
      })
    );

    const result = await resolveDoi("10.48550/arXiv.1706.03762");
    expect(result.type).toBe("article-journal");
    expect(result.title).toBe("Attention Is All You Need");
    expect(result.DOI).toBe("10.48550/arXiv.1706.03762");
  });

  it("throws on HTTP 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
    );

    await expect(resolveDoi("10.9999/nonexistent")).rejects.toThrow(
      "DOI resolution failed for 10.9999/nonexistent: 404 Not Found (DOI not registered or mistyped)"
    );
  });

  it("HTTP 5xx after the retries → says the registry is failing, retry later", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, statusText: "", headers: new Headers() }));
    await expect(resolveDoi("10.1/x")).rejects.toThrow(
      "DOI resolution failed for 10.1/x: 502 (doi.org or the registry is busy or failing: retry later)"
    );
  });

  it("retries on 429 and resolves successfully", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "Retry-After": "0" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCslResponse),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDoi("10.48550/arXiv.1706.03762");
    expect(result.title).toBe("Attention Is All You Need");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network error"))
    );

    await expect(resolveDoi("10.1234/broken")).rejects.toThrow("Network error");
  });
});

describe("resolveDois", () => {
  it("resolves multiple DOIs with mixed results", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockCslResponse),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDois([
      "10.48550/arXiv.1706.03762",
      "10.9999/nonexistent",
    ]);

    expect(result.success).toHaveLength(1);
    expect(result.success[0].doi).toBe("10.48550/arXiv.1706.03762");
    expect(result.success[0].data.title).toBe("Attention Is All You Need");

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].doi).toBe("10.9999/nonexistent");
    expect(result.failed[0].error).toContain("DOI resolution failed");
  });

  it("accepts an optional concurrency parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockCslResponse),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveDois(
      ["10.48550/arXiv.1706.03762", "10.48550/arXiv.1706.03762"],
      1
    );

    expect(result.success).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
  });
});
