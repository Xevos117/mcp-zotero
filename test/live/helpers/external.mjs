// Text of a tool result that means an external service failed (doi.org, Crossref, Unpaywall, publishers, network),
// not the tool. A module of its own, without side effects (helpers/live.ts reads the vitest context when it loads),
// so unit tests and plain node scripts can import it. 429 and 5xx count, as in probe() of helpers/live.ts.

export const EXTERNAL_PATTERNS = [
  /DOI resolution failed for [^"\n]*?: (?:429|5\d\d)\b/,
  /timed out after/i,
  /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i,
  /Download failed for all \d+ URL/,
  /(?:status|HTTP) (?:5\d\d|429)\b/,
];

/** The matched text, if `text` reports a failure of an external service; otherwise null. */
export function externalReason(text) {
  const hit = EXTERNAL_PATTERNS.find((re) => re.test(String(text)));
  return hit ? (String(text).match(hit)?.[0] ?? "external failure") : null;
}
