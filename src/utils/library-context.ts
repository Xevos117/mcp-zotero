/**
 * Library context helpers — let this MCP target either a user library or a
 * group library, controlled by environment variables OR per-call args.
 *
 * Defaults:
 *   ZOTERO_LIBRARY_TYPE   "user" (default) | "group"
 *   ZOTERO_LIBRARY_ID     numeric library ID; falls back to ZOTERO_USER_ID for
 *                         back-compat when targeting the user library.
 *   ZOTERO_USER_ID        legacy / required when ZOTERO_LIBRARY_ID is unset.
 *
 * Per-call override (optional args on every tool):
 *   library_type          "user" | "group"  — overrides env default
 *   library_id            string             — overrides env default
 *
 * Resolution order: arg > env > implicit default ("user", ZOTERO_USER_ID).
 * Lets a single server instance target multiple libraries (e.g., StagingOutput
 * group AND DART-output group) without restarting.
 */
import { z } from "zod";

export type LibraryType = "user" | "group";

export function getLibraryType(): LibraryType {
  const raw = (process.env.ZOTERO_LIBRARY_TYPE ?? "user").toLowerCase();
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
    .optional()
    .describe(
      "Override the configured library ID for this call. " +
      "Defaults to ZOTERO_LIBRARY_ID env (or ZOTERO_USER_ID). " +
      "Set together with library_type when targeting a different library."
    ),
} as const;

export interface LibraryArgs {
  library_type?: "user" | "group";
  library_id?: string;
}

/**
 * Resolve the library context for a single tool call. Per-call args win,
 * else env defaults, else throws if the resolved id is empty.
 */
export function resolveLibrary(
  args: LibraryArgs,
  defaultLibraryId: string
): { type: LibraryType; id: string } {
  const type: LibraryType = args.library_type !== undefined ? args.library_type : getLibraryType();
  const id = args.library_id ?? defaultLibraryId;
  if (!id) {
    throw new Error(
      "Zotero library ID is not set. Provide library_id arg, or set " +
      "ZOTERO_LIBRARY_ID / ZOTERO_USER_ID in the server environment."
    );
  }
  return { type, id };
}
