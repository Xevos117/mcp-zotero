/**
 * Library context helpers — let this MCP target either a user library or a
 * group library, controlled by environment variables OR per-call args.
 *
 * Defaults:
 *   ZOTERO_LIBRARY_TYPE   "user" (default) | "group"
 *   ZOTERO_LIBRARY_ID     numeric library ID; required when type is "group",
 *                         falls back to ZOTERO_USER_ID for user libraries.
 *   ZOTERO_USER_ID        numeric user ID; required for user libraries when
 *                         ZOTERO_LIBRARY_ID is unset.
 *
 * Per-call override (optional args on every tool):
 *   library_type          "user" | "group"  — overrides env default
 *   library_id            numeric string    — overrides env default
 *
 * Resolution order: arg > env > implicit default ("user", ZOTERO_USER_ID).
 * Switching library_type per call without library_id is only allowed towards
 * the personal library (ZOTERO_USER_ID); a group needs an explicit id.
 */
import { z } from "zod";

export type LibraryType = "user" | "group";

/** Zotero user and group IDs are numeric; also keeps ids safe to interpolate into API URLs. */
const LIBRARY_ID_PATTERN = /^\d+$/;

export function getLibraryType(): LibraryType {
  // `||` (not `??`) so an empty ZOTERO_LIBRARY_TYPE from a config template means "user"
  const raw = (process.env.ZOTERO_LIBRARY_TYPE || "user").trim().toLowerCase();
  if (raw !== "user" && raw !== "group") {
    throw new Error(
      `ZOTERO_LIBRARY_TYPE must be 'user' or 'group' (got '${raw}')`
    );
  }
  return raw;
}

export function getLibraryId(): string {
  return process.env.ZOTERO_LIBRARY_ID || process.env.ZOTERO_USER_ID || "";
}

function assertLibraryId(id: string, source: string): void {
  if (!LIBRARY_ID_PATTERN.test(id)) {
    throw new Error(`${source} must be a numeric Zotero library ID (got '${id}')`);
  }
}

/**
 * Validate the library configuration from the environment at startup.
 * Returns the default library the server operates on.
 */
export function getDefaultLibrary(): { type: LibraryType; id: string } {
  const type = getLibraryType();
  if (type === "group" && !process.env.ZOTERO_LIBRARY_ID) {
    // Without this check the user ID would silently be used as a group ID
    throw new Error("ZOTERO_LIBRARY_TYPE=group requires ZOTERO_LIBRARY_ID (the numeric group ID)");
  }
  const id = getLibraryId();
  if (!id) {
    throw new Error("Missing ZOTERO_USER_ID or ZOTERO_LIBRARY_ID environment variable");
  }
  assertLibraryId(id, process.env.ZOTERO_LIBRARY_ID ? "ZOTERO_LIBRARY_ID" : "ZOTERO_USER_ID");
  return { type, id };
}

/** Per-call library override args. Spread into any tool's inputSchema. */
export const libraryArgsSchema = {
  library_type: z
    .enum(["user", "group"])
    .optional()
    .describe(
      "Override the configured Zotero library type for this call. " +
      "Defaults to ZOTERO_LIBRARY_TYPE env (or 'user'). " +
      "Use to target a different library per call without restarting the server."
    ),
  library_id: z
    .string()
    .regex(LIBRARY_ID_PATTERN, "library_id must be a numeric Zotero library ID")
    .optional()
    .describe(
      "Override the configured library ID for this call. " +
      "Defaults to ZOTERO_LIBRARY_ID env (or ZOTERO_USER_ID). " +
      "Required when library_type is 'group' and the server is configured for a user library."
    ),
} as const;

export interface LibraryArgs {
  library_type?: "user" | "group";
  library_id?: string;
}

/**
 * Resolve the library context for a single tool call. Per-call args win,
 * else env defaults, else throws if the resolved id is empty or not numeric.
 */
export function resolveLibrary(
  args: LibraryArgs,
  defaultLibraryId: string
): { type: LibraryType; id: string } {
  const defaultType = getLibraryType();
  const type: LibraryType = args.library_type ?? defaultType;
  let id = args.library_id;
  if (id === undefined) {
    if (type === defaultType) {
      id = defaultLibraryId;
    } else if (type === "user") {
      // Switching from the configured group back to the personal library
      id = process.env.ZOTERO_USER_ID;
    } else {
      // The default id belongs to a user library: never reuse it as a group id
      throw new Error(
        "library_id is required when library_type is 'group' and the server is configured for a user library."
      );
    }
  }
  if (!id) {
    throw new Error(
      "Zotero library ID is not set. Provide library_id arg, or set " +
      "ZOTERO_LIBRARY_ID / ZOTERO_USER_ID in the server environment."
    );
  }
  assertLibraryId(id, "library_id");
  return { type, id };
}
