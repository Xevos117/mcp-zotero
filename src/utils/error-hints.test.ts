import { describe, it, expect } from "vitest";
import { describeError, describeAnyError, unsafeOperationsHint, zoteroStatusHint } from "./error-hints.js";
import { RequestTimeoutError } from "./timeouts.js";

function apiError(status: number, reason = "", headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`${status}: `), {
    reason,
    response: { status, url: "https://api.zotero.org/users/1/items", headers: new Headers(headers) },
  });
}

describe("describeError", () => {
  it("403 → access problem, user-side fix with the keys page and the server settings", () => {
    const d = describeError(apiError(403, "Write access denied"))!;
    expect(d).toMatchObject({ http_status: 403, details: "Write access denied" });
    expect(d.error).toMatch(/refused access \(HTTP 403 Forbidden\)/);
    expect(d.hint).toContain("https://www.zotero.org/settings/keys");
    expect(d.hint).toContain("Allow write access");
    expect(d.hint).toContain("ZOTERO_API_KEY");
    expect(d.hint).toMatch(/restart the client/);
    expect(d.hint).toMatch(/will not help/);
  });

  it("404 → do not retry the same key, where to get valid keys", () => {
    const d = describeError(apiError(404))!;
    expect(d.error).toMatch(/404 Not Found/);
    expect(d.hint).toMatch(/Do not retry/);
    expect(d.hint).toContain("search_library");
    expect(d.hint).toContain("get_collections");
  });

  it.each([409, 412])("%i → retry once", (status) => {
    expect(describeError(apiError(status))!.hint).toBe("Retry the same call once.");
  });

  it("429 with Retry-After → wait that long", () => {
    const d = describeError(apiError(429, "", { "Retry-After": "7" }))!;
    expect(d).toMatchObject({ http_status: 429, retry_after_s: 7 });
    expect(d.hint).toMatch(/^Wait 7 s and retry once/);
  });

  it.each([500, 502, 503])("%i → temporarily unavailable, wait and retry, then tell the user", (status) => {
    const d = describeError(apiError(status))!;
    expect(d.error).toMatch(/temporarily unavailable/);
    expect(d.hint).toMatch(/Wait about a minute and retry once/);
    expect(d.hint).toMatch(/tell the user/);
  });

  it("400 → fix the arguments, retrying unchanged fails again", () => {
    expect(describeError(apiError(400, "'foo' is not a valid field"))).toMatchObject({
      error: expect.stringContaining("400 Bad Request"),
      details: "'foo' is not a valid field",
      hint: expect.stringMatching(/Retrying unchanged will fail again/),
    });
  });

  it("an HTML error body is not copied into details; long bodies are cut", () => {
    expect(describeError(apiError(500, "<html><body>oops</body></html>"))).not.toHaveProperty("details");
    expect(describeError(apiError(400, "x".repeat(400)))!.details).toHaveLength(301);
  });

  it("timeout → message kept, retry once and check for a saved write before repeating it", () => {
    const d = describeError(new RequestTimeoutError("Zotero API request (POST) timed out after 30 s (api.zotero.org)"))!;
    expect(d.error).toBe("Zotero API request (POST) timed out after 30 s (api.zotero.org)");
    expect(d.hint).toMatch(/Retry once/);
    expect(d.hint).toMatch(/duplicates/);
  });

  it("network error → cause included, retry then tell the user about connectivity", () => {
    const err = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.zotero.org") });
    const d = describeError(err)!;
    expect(d.error).toBe("Network error: fetch failed (getaddrinfo ENOTFOUND api.zotero.org)");
    expect(d.hint).toMatch(/cannot reach the service/);
  });

  it("other errors (bugs) are not described; describeAnyError keeps the raw message", () => {
    expect(describeError(new TypeError("Cannot read properties of undefined"))).toBeUndefined();
    expect(describeError(new Error("boom"))).toBeUndefined();
    expect(describeAnyError(new Error("boom"))).toEqual({ error: "boom" });
  });
});

describe("zoteroStatusHint", () => {
  it("unknown status → generic retry", () => {
    expect(zoteroStatusHint(418)).toEqual({ error: "Zotero API error (HTTP 418).", hint: expect.stringMatching(/^Retry once/) });
  });
});

describe("unsafeOperationsHint", () => {
  it("items: names both accepted values and what they enable, forbids workarounds", () => {
    const h = unsafeOperationsHint("items");
    expect(h).toContain("'items' (allows delete_items) or 'all' (also delete_collection)");
    expect(h).toMatch(/Do not try to get around this with other tools/);
    expect(h).toContain("claude_desktop_config.json");
    expect(h).toMatch(/restart the client/);
  });

  it("collections: only 'all' enables delete_collection", () => {
    expect(unsafeOperationsHint("collections")).toContain("'all' (allows delete_collection and delete_items; 'items' allows only delete_items)");
  });
});
