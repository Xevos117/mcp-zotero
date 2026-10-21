import { isZoteroApiError } from "../types/zotero-types.js";
import { errorMessage } from "./error-formatter.js";
import { RequestTimeoutError } from "./timeouts.js";

/**
 * Wording shared by the tool errors: each one says what happened, what the model can do next and,
 * when the fix is on the user's side, what to tell the user. No secrets: status codes and hosts only.
 */

/**
 * Server settings as the user sees them: the variable name, and the title of the same setting in the Claude Desktop
 * extension (user_config of manifest.json), which has no env block.
 */
export const SETTINGS = {
  apiKey: { env: "ZOTERO_API_KEY", title: "Zotero API key" },
  userId: { env: "ZOTERO_USER_ID", title: "Zotero user ID" },
  libraryId: { env: "ZOTERO_LIBRARY_ID", title: "Group library ID" },
  unpaywallEmail: { env: "UNPAYWALL_EMAIL", title: "Email for Unpaywall" },
  unsafeOperations: { env: "UNSAFE_OPERATIONS", title: "Deletions allowed" },
} as const;

type Setting = (typeof SETTINGS)[keyof typeof SETTINGS];

/** Where the user changes these settings, for every "tell the user" hint: extension or MCP config, then a restart. */
export function whereToSet(...settings: Setting[]): string {
  const titles = settings.map((s) => `"${s.title}"`).join(" / ");
  const envs = settings.map((s) => s.env).join(" / ");
  return (
    `the server's settings: with the Claude Desktop extension, ${titles} in Settings → Extensions → MCP Zotero; ` +
    `in other clients, ${envs} in the env block of this server in the MCP config (e.g. claude_desktop_config.json or .mcp.json). ` +
    "Then restart the client"
  );
}

export const API_KEYS_PAGE = "https://www.zotero.org/settings/keys";

/** Hint for an argument that must be an existing item key. */
export const ITEM_KEY_HINT =
  "Get valid item keys from search_library or get_collection_items (for a group library pass the same library_type and library_id); never guess keys.";

/** Hint for an argument that must be an existing collection key. */
export const COLLECTION_KEY_HINT =
  "Get valid collection keys from get_collections (for a group library pass the same library_type and library_id); never guess keys.";

export const MISSING_API_KEY = "ZOTERO_API_KEY is not set in the server's environment";

export const MISSING_API_KEY_HINT =
  `Tell the user to create a Zotero API key at ${API_KEYS_PAGE} and set it in ${whereToSet(SETTINGS.apiKey)}.`;

const ACCESS_HINT =
  "Retrying or using other tools will not help. Tell the user to check the API key at " +
  `${API_KEYS_PAGE}: it needs "Allow library access", "Allow write access" for tools that add or delete, ` +
  "and access to the group for a group library; ZOTERO_USER_ID must be the userID shown on that page. " +
  `They fix it by updating the key / user ID in ${whereToSet(SETTINGS.apiKey, SETTINGS.userId)}.`;

const STATUS_NAMES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  412: "Precondition Failed",
  413: "Request Entity Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function statusLabel(status: number): string {
  return STATUS_NAMES[status] ? `HTTP ${status} ${STATUS_NAMES[status]}` : `HTTP ${status}`;
}

function retryWait(retryAfterS: number | undefined): string {
  return retryAfterS !== undefined ? `${retryAfterS} s` : "about a minute";
}

/** What a Zotero Web API status means for the model: the error text and the next step. */
export function zoteroStatusHint(status: number, retryAfterS?: number): { error: string; hint: string } {
  const label = statusLabel(status);
  if (status === 401 || status === 403) {
    return {
      error: `Zotero refused access (${label}): the API key is invalid or revoked, cannot access this library, or lacks write access for this operation.`,
      hint: ACCESS_HINT,
    };
  }
  if (status === 404) {
    return {
      error: `Zotero returned ${label}: the library, item or collection does not exist or this API key cannot see it.`,
      hint: `Do not retry with the same item or collection key. ${ITEM_KEY_HINT} Collection keys come from get_collections. If every call fails like this, the configured library id is wrong: tell the user to check the user ID (the userID at ${API_KEYS_PAGE}) or group library ID in ${whereToSet(SETTINGS.userId, SETTINGS.libraryId)}.`,
    };
  }
  if (status === 409 || status === 412) {
    return {
      error: `The Zotero library changed or was locked during the request (${label}).`,
      hint: "Retry the same call once.",
    };
  }
  if (status === 429) {
    return {
      error: `Zotero rate limit reached (${label}).`,
      hint: `Wait ${retryWait(retryAfterS)} and retry once; avoid parallel calls and send fewer items per call.`,
    };
  }
  if (status >= 500) {
    return {
      error: `The Zotero API is temporarily unavailable (${label}).`,
      hint: `Wait ${retryWait(retryAfterS)} and retry once. If it keeps failing, tell the user that Zotero's servers seem to have problems and to try again later.`,
    };
  }
  if (status === 400 || status === 413) {
    return {
      error: `Zotero rejected the request (${label}).`,
      hint: "Retrying unchanged will fail again: check the arguments (and details, if present), fix them and retry; for large batches send fewer items per call.",
    };
  }
  return { error: `Zotero API error (${label}).`, hint: "Retry once; if it fails again, tell the user what failed." };
}

const NETWORK_ERROR =
  /fetch failed|socket hang up|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/;

/**
 * A failed connection (DNS, refused, reset), as thrown by fetch: a TypeError, the cause carrying the code. Only these
 * markers count: a bug's TypeError that merely mentions a network is not reported as a retryable network error.
 */
function networkDetail(err: unknown): string | undefined {
  if (!(err instanceof TypeError)) return undefined;
  const cause = (err as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  const text = causeMessage ? `${err.message} (${causeMessage})` : err.message;
  return NETWORK_ERROR.test(text) ? text : undefined;
}

function retryAfterSeconds(response: { headers?: { get?: (name: string) => string | null } }): number | undefined {
  const raw = response.headers?.get?.("Retry-After");
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Short plain-text reason from a Zotero error body ("Write access denied"), never an HTML page. */
function apiReason(err: unknown): string | undefined {
  const reason = (err as { reason?: unknown }).reason;
  if (typeof reason !== "string") return undefined;
  const text = reason.trim();
  if (!text || /^</.test(text)) return undefined;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export interface DescribedError {
  error: string;
  hint: string;
  http_status?: number;
  retry_after_s?: number;
  details?: string;
}

/**
 * Error text and next step for a failure a tool did not handle itself: Zotero API errors, timeouts and
 * network errors. Undefined for anything else (a bug), which keeps its own message.
 */
export function describeError(err: unknown): DescribedError | undefined {
  if (isZoteroApiError(err)) {
    const status = err.response.status;
    const retry_after_s = retryAfterSeconds(err.response as never);
    const { error, hint } = zoteroStatusHint(status, retry_after_s);
    const details = apiReason(err);
    return {
      error,
      hint,
      http_status: status,
      ...(retry_after_s !== undefined ? { retry_after_s } : {}),
      ...(details ? { details } : {}),
    };
  }
  if (err instanceof RequestTimeoutError) {
    return {
      error: err.message,
      hint:
        "Retry once. A write that timed out may still have been saved: check with search_library before repeating it, to avoid duplicates. " +
        "If it keeps timing out, tell the user to check the network connection of the machine running this server.",
    };
  }
  const network = networkDetail(err);
  if (network) {
    return {
      error: `Network error: ${network}`,
      hint: "Retry once. If it keeps failing, tell the user that the machine running this server cannot reach the service (internet connection, DNS, proxy or firewall).",
    };
  }
  return undefined;
}

/** describeError, falling back to the raw message (with no hint) for unexpected errors. */
export function describeAnyError(err: unknown): DescribedError | { error: string } {
  return describeError(err) ?? { error: errorMessage(err) };
}

/** Hint for a deletion blocked by UNSAFE_OPERATIONS: tell the user how to enable it, never work around it. */
export function unsafeOperationsHint(target: "items" | "collections"): string {
  const values =
    target === "items"
      ? "'items' (allows delete_items) or 'all' (also delete_collection)"
      : "'all' (allows delete_collection and delete_items; 'items' allows only delete_items)";
  return (
    "Do not try to get around this with other tools (moving to the trash, editing, removing from collections). " +
    `Tell the user that deleting is disabled in the server configuration and that, if they want to allow it, they can set ${values} ` +
    `in ${whereToSet(SETTINGS.unsafeOperations)}, and then ask again.`
  );
}
