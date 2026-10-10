import { isZoteroApiError } from "../types/zotero-types.js";
import { logger } from "./logger.js";

function jsonContent(body: unknown) {
  return [{ type: "text" as const, text: JSON.stringify(body, null, 2) }];
}

/** Successful tool result: the body serialised as indented JSON text. */
export function formatJsonResult(body: unknown) {
  return { content: jsonContent(body) };
}

/**
 * Structured tool error: JSON `{ error, ...details }` flagged with `isError: true`, as the MCP
 * convention requires for tool failures. Partial successes must return a normal result instead.
 */
export function formatErrorResponse(message: string, details: Record<string, unknown> = {}) {
  return { isError: true as const, content: jsonContent({ error: message, ...details }) };
}

/**
 * Valid result with nothing in it (empty search, empty collection): JSON `{ message, ...details }`
 * without isError, so the model does not take "nothing found" for a broken tool and retry.
 */
export function formatEmptyResult(message: string, details: Record<string, unknown> = {}) {
  return formatJsonResult({ message, ...details });
}

/** Message of any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Log a failed Zotero API request made by a tool (status and URL go to stderr, never to the client). */
export function logToolError(tool: string, err: unknown): void {
  if (isZoteroApiError(err)) {
    logger.error("Tool execution failed", {
      tool,
      status: err.response?.status,
      errorMessage: err.message,
      url: err.response?.url,
    });
  }
}
