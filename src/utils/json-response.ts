/**
 * A response body that is not the JSON object the API documents: an HTML error or landing page (doi.org answers
 * an unresolvable DOI with HTML), an empty body, or a bare value. The message names the status and content type,
 * never the raw JSON.parse error.
 */
export class InvalidJsonResponseError extends Error {
  readonly status: number;
  constructor(response: Response) {
    const type = response.headers?.get?.("content-type")?.split(";")[0].trim();
    super(`response is not a JSON object (HTTP ${response.status}${type ? `, ${type}` : ""})`);
    this.name = "InvalidJsonResponseError";
    this.status = response.status;
  }
}

/** Body of `response` as a JSON object; InvalidJsonResponseError otherwise. Timeouts while reading propagate. */
export async function readJsonObject<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    if (err instanceof SyntaxError) throw new InvalidJsonResponseError(response);
    throw err;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new InvalidJsonResponseError(response);
  return data as T;
}
