import { describe, it, expect, vi, afterEach } from "vitest";
import { putFulltext } from "./zotero-fulltext.js";

describe("putFulltext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success on 204 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ status: 204 })
    );

    const result = await putFulltext("user", "12345", "ITEM01", "api-key", "Some text", 3);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.zotero.org/users/12345/items/ITEM01/fulltext",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Zotero-API-Key": "api-key",
        },
        body: JSON.stringify({
          content: "Some text",
          indexedPages: 3,
          totalPages: 3,
        }),
      }
    );
  });

  it("returns error on 403 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ status: 403 })
    );

    const result = await putFulltext("user", "12345", "ITEM01", "bad-key", "text", 1);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Fulltext PUT failed with status 403");
  });

  it("returns error on 500 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ status: 500 })
    );

    const result = await putFulltext("user", "12345", "ITEM01", "api-key", "text", 1);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Fulltext PUT failed with status 500");
  });

  it("propagates fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("Network error"))
    );

    await expect(
      putFulltext("user", "12345", "ITEM01", "api-key", "text", 1)
    ).rejects.toThrow("Network error");
  });
});
