import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./pdf-uploader.js", () => ({ downloadAndUploadPdf: vi.fn() }));

import { uploadFirstAvailablePdf } from "./pdf-fallback.js";
import { downloadAndUploadPdf } from "./pdf-uploader.js";
import { createZoteroApiMock } from "../__mocks__/zotero-api.mock.js";

const upload = vi.mocked(downloadAndUploadPdf);
const fail = (code: "download_failed" | "storage_quota_exceeded", message: string) =>
  ({ success: false, error: { code, message } }) as const;

describe("uploadFirstAvailablePdf", () => {
  beforeEach(() => upload.mockReset());

  it("stops at the first URL that works and passes the options through", async () => {
    upload.mockResolvedValueOnce(fail("download_failed", "status 403")).mockResolvedValueOnce({
      success: true,
      itemKey: "ATT1",
      filename: "a.pdf",
      sizeBytes: 1,
      fulltextIndexed: false,
      fulltextStatus: "",
    });
    const { mock } = createZoteroApiMock();
    const result = await uploadFirstAvailablePdf(mock, "user", "1", "k", ["u1", "u2", "u3"], { parentItem: "P", doi: "10.1/x" });
    expect(result).toMatchObject({ attached: true, pdfUrl: "u2" });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][4]).toEqual({ parentItem: "P", doi: "10.1/x", url: "u2" });
  });

  it("does not try further URLs after a storage-quota error", async () => {
    upload.mockResolvedValueOnce(fail("storage_quota_exceeded", "quota full"));
    const { mock } = createZoteroApiMock();
    const result = await uploadFirstAvailablePdf(mock, "user", "1", "k", ["u1", "u2"], {});
    expect(result).toEqual({ attached: false, quotaExceeded: true, message: "quota full", failedUrls: [{ url: "u1", error: "quota full" }] });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("keeps the single error message when only one URL was tried", async () => {
    upload.mockResolvedValueOnce(fail("download_failed", "status 404"));
    const { mock } = createZoteroApiMock();
    const result = await uploadFirstAvailablePdf(mock, "user", "1", "k", ["u1"], {});
    expect(result).toMatchObject({ attached: false, quotaExceeded: false, message: "status 404" });
  });
});
