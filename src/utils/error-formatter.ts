function jsonContent(body: Record<string, unknown>) {
  return [{ type: "text" as const, text: JSON.stringify(body, null, 2) }];
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
  return { content: jsonContent({ message, ...details }) };
}
