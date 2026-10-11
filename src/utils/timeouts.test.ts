import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { fetchWithTimeout, withRequestTimeout, RequestTimeoutError, TIMEOUTS } from "./timeouts.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { resolveDoi } from "./doi-resolver.js";
import { putFulltext } from "./zotero-fulltext.js";
import { ZoteroApiInterface } from "../types/zotero-types.js";

/** fetch that never answers: it settles only when the caller's signal aborts, like a stalled server. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })
  );
}

describe("timeouts", () => {
  const saved = { ...TIMEOUTS };
  afterEach(() => {
    Object.assign(TIMEOUTS, saved);
    vi.unstubAllGlobals();
  });

  it("fetchWithTimeout: server fermo → RequestTimeoutError con operazione, bound e host", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const err = await fetchWithTimeout("https://slow.example.org/x", {}, 50, "PDF download").catch((e) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(err.message).toBe("PDF download timed out after 0.05 s (slow.example.org)");
  });

  it("fetchWithTimeout: l'abort del chiamante resta un abort, non un timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctrl = new AbortController();
    const p = fetchWithTimeout("https://slow.example.org/x", { signal: ctrl.signal }, 10_000, "X");
    ctrl.abort();
    const err = await p.catch((e) => e);
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
    expect(err.name).toBe("AbortError");
  });

  it("fetchWithRetry: il timeout di un tentativo non viene ritentato", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://api.example.org/", undefined, { timeoutMs: 50, label: "Lookup" })).rejects.toThrow(
      "Lookup timed out after 0.05 s (api.example.org)"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolveDoi usa TIMEOUTS.metadataMs e nomina l'operazione", async () => {
    TIMEOUTS.metadataMs = 50;
    vi.stubGlobal("fetch", hangingFetch());
    await expect(resolveDoi("10.1/x")).rejects.toThrow("DOI resolution timed out after 0.05 s (doi.org)");
  });

  it("putFulltext usa TIMEOUTS.zoteroApiMs", async () => {
    TIMEOUTS.zoteroApiMs = 50;
    vi.stubGlobal("fetch", hangingFetch());
    await expect(putFulltext("user", "1", "ITEM0001", "k", "text", 1)).rejects.toThrow(
      "Zotero fulltext upload timed out after 0.05 s (api.zotero.org)"
    );
  });

  describe("withRequestTimeout (zotero-api-client reale)", () => {
    const client = () => {
      const factory = createRequire(import.meta.url)("zotero-api-client").default;
      return withRequestTimeout(factory("k") as ZoteroApiInterface);
    };

    it.each([
      ["GET", (api: ZoteroApiInterface) => api.library("user", "1").items().get({ limit: 5 })],
      ["POST", (api: ZoteroApiInterface) => api.library("user", "1").items().post([{ itemType: "book" }])],
      ["DELETE", (api: ZoteroApiInterface) => api.library("user", "1").version(3).items().delete(["ABCD1234"])],
    ])("%s appeso → RequestTimeoutError chiaro", async (verb, run) => {
      TIMEOUTS.zoteroApiMs = 50;
      vi.stubGlobal("fetch", hangingFetch());
      await expect(run(client())).rejects.toThrow(`Zotero API request (${verb}) timed out after 0.05 s (api.zotero.org)`);
    });

    it("ogni richiesta riceve il proprio signal; i parametri del chiamante restano nell'URL", async () => {
      const fetchMock = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Total-Results": "0" } }));
      vi.stubGlobal("fetch", fetchMock);
      const api = client();
      await api.library("user", "1").items().get({ limit: 5, sort: "title" });
      await api.library("user", "1").collections().get();
      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(calls[0][0]).toContain("limit=5");
      expect(calls[0][0]).toContain("sort=title");
      expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(calls[1][1].signal).toBeInstanceOf(AbortSignal);
      expect(calls[1][1].signal).not.toBe(calls[0][1].signal);
    });
  });
});
