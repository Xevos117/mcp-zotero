/**
 * Library context helpers — let this MCP target either a user library or a
 * group library, controlled by environment variables.
 *
 *   ZOTERO_LIBRARY_TYPE   "user" (default) | "group"
 *   ZOTERO_LIBRARY_ID     numeric library ID; falls back to ZOTERO_USER_ID for
 *                         back-compat when targeting the user library.
 *   ZOTERO_USER_ID        legacy / required when ZOTERO_LIBRARY_ID is unset.
 */

export type LibraryType = "user" | "group";

/**
 * Returns the configured Zotero library type. Reads ZOTERO_LIBRARY_TYPE at
 * call time (so tests that mutate env vars at runtime see the change).
 * Throws if the value is anything other than "user" or "group".
 */
export function getLibraryType(): LibraryType {
  const raw = (process.env.ZOTERO_LIBRARY_TYPE ?? "user").toLowerCase();
  if (raw !== "user" && raw !== "group") {
    throw new Error(
      `ZOTERO_LIBRARY_TYPE must be 'user' or 'group' (got '${raw}')`
    );
  }
  return raw;
}

/**
 * Returns the configured Zotero library ID. Prefers ZOTERO_LIBRARY_ID and
 * falls back to ZOTERO_USER_ID. Returns "" if neither is set — the server
 * startup check rejects that case before any tool is called.
 */
export function getLibraryId(): string {
  return process.env.ZOTERO_LIBRARY_ID || process.env.ZOTERO_USER_ID || "";
}
