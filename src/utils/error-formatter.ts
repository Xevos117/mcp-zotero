/**
 * Structured tool error: JSON `{ error, ...details }` flagged with `isError: true`, as the MCP
 * convention requires for tool failures. Partial successes must return a normal result instead.
 */
export function formatErrorResponse(message: string, details: Record<string, unknown> = {}) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: message,
            ...details,
          },
          null,
          2
        ),
      },
    ],
  };
}
