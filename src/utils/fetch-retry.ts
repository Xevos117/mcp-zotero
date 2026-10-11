import { fetchWithTimeout, TIMEOUTS } from "./timeouts.js";

export interface FetchRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  retryableStatuses?: number[];
  /** Bound for each attempt (default TIMEOUTS.metadataMs); a timeout is not retried. */
  timeoutMs?: number;
  /** Operation name used in the timeout error (e.g. "DOI resolution"). */
  label?: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_RETRYABLE_STATUSES = [429, 503];

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delayMs = date - Date.now();
    return delayMs > 0 ? delayMs : 0;
  }
  return null;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: FetchRetryOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const retryableStatuses = options?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchWithTimeout(url, init ?? {}, options?.timeoutMs ?? TIMEOUTS.metadataMs, options?.label ?? "Request");
    lastResponse = response;

    if (!retryableStatuses.includes(response.status) || attempt === maxRetries) {
      return response;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    const delayMs = retryAfterMs ?? baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return lastResponse!;
}
