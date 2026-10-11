import { ZoteroApiInterface } from "../types/zotero-types.js";

/**
 * Bounds for every network call the server makes. A remote that accepts the connection and then
 * never answers would otherwise block a tool until the MCP client gives up, with no useful error.
 * Values are read at call time, so tests can lower them.
 */
export const TIMEOUTS = {
  /** Zotero Web API: metadata reads/writes, fulltext, upload authorization and registration. */
  zoteroApiMs: 30_000,
  /** DOI resolution (doi.org / Crossref) and Unpaywall lookups, per attempt. */
  metadataMs: 30_000,
  /**
   * PDF download and upload to Zotero storage, body included. Files are capped at 100 MB, so this
   * allows ~0.6 MB/s for the largest file; typical papers (1-10 MB) finish in seconds.
   */
  pdfTransferMs: 180_000,
};

/** A network call that hit its bound. The message names the operation, host and bound. */
export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

/** True for the abort raised by AbortSignal.timeout (DOMException "TimeoutError"). */
export function isTimeoutAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError";
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function seconds(ms: number): string {
  return `${ms / 1000} s`;
}

export function timeoutError(label: string, url: string, timeoutMs: number): RequestTimeoutError {
  return new RequestTimeoutError(`${label} timed out after ${seconds(timeoutMs)} (${host(url)})`);
}

/** Signal that aborts after `timeoutMs`, combined with the caller's signal when there is one. */
export function timeoutSignal(timeoutMs: number, signal?: AbortSignal | null): AbortSignal {
  const bound = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, bound]) : bound;
}

/**
 * fetch() with a bound. The signal stays attached to the response, so reading the body is bounded
 * too: callers that read it should map isTimeoutAbort() errors with timeoutError().
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: timeoutSignal(timeoutMs, init.signal) });
  } catch (err) {
    if (isTimeoutAbort(err)) throw timeoutError(label, url, timeoutMs);
    throw err;
  }
}

const VERB_OPTS_INDEX: Record<string, number> = { get: 0, post: 1, put: 1, patch: 1, delete: 1 };

/**
 * Wraps a zotero-api-client instance so every request carries a fresh AbortSignal.timeout
 * (the client forwards `signal` to fetch). Chain methods return wrapped chains; terminal verbs get
 * the signal merged into their options, and a timeout becomes a RequestTimeoutError.
 */
export function withRequestTimeout(api: ZoteroApiInterface, timeoutMs?: number): ZoteroApiInterface {
  return new Proxy(api, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      const optsIndex = VERB_OPTS_INDEX[prop];
      if (optsIndex === undefined) {
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result && typeof result === "object" ? withRequestTimeout(result as ZoteroApiInterface, timeoutMs) : result;
        };
      }
      return async (...args: unknown[]) => {
        const bound = timeoutMs ?? TIMEOUTS.zoteroApiMs;
        const opts = (args[optsIndex] ?? {}) as Record<string, unknown>;
        const callArgs = [...args];
        callArgs[optsIndex] = { ...opts, signal: timeoutSignal(bound, opts.signal as AbortSignal | undefined) };
        try {
          return await value.apply(target, callArgs);
        } catch (err) {
          if (isTimeoutAbort(err)) {
            throw new RequestTimeoutError(`Zotero API request (${prop.toUpperCase()}) timed out after ${seconds(bound)} (api.zotero.org)`);
          }
          throw err;
        }
      };
    },
  });
}
