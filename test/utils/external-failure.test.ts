import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs module without type declarations
import { externalReason } from "../../test/live/helpers/external.mjs";

/**
 * Guasti esterni riconosciuti dai casi `soft` della suite dal vivo (test/live/helpers/external.mjs): solo questi
 * diventano uno skip, ogni altro errore fa fallire il test. Qui perché test/live/** è escluso da `npm test`.
 */
describe("guasti esterni della suite dal vivo (EXT)", () => {
  it.each([
    ["DOI resolution failed for 10.1000/x: 503 Service Unavailable", "DOI resolution failed for 10.1000/x: 503"],
    ["DOI resolution failed for 10.1000/x: 429", "DOI resolution failed for 10.1000/x: 429"],
    ["Request to doi.org timed out after 30000 ms", "timed out after"],
    ["Network error: fetch failed (ECONNRESET)", "fetch failed"],
    ["Download failed for all 3 URLs", "Download failed for all 3 URL"],
    ['{"error":"The Zotero API is temporarily unavailable (HTTP 500 Internal Server Error)."}', "HTTP 500"],
    ["Unpaywall lookup failed: status 502", "status 502"],
    ["HTTP 504 Gateway Timeout", "HTTP 504"],
    ["HTTP 429 Too Many Requests", "HTTP 429"],
  ])("EXT-01 %s → guasto esterno", (text, reason) => {
    expect(externalReason(text)).toBe(reason);
  });

  it.each([
    "HTTP 404 Not Found",
    "HTTP 403 Forbidden",
    "HTTP 412 Precondition Failed",
    "DOI resolution failed for 10.1000/x: 404",
    "HTTP 5000 items",
    '{"error":"No items found for the given keys","status":"not_found"}',
  ])("EXT-02 %s → non esterno (il test fallisce)", (text) => {
    expect(externalReason(text)).toBeNull();
  });
});
