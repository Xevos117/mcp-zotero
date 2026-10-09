import { ZoteroWriteError } from "../types/zotero-types.js";

/** Format one entry of MultiWriteResponse.getErrors() ({ key, code, message }) as readable text. */
export function formatWriteError(error: ZoteroWriteError | string): string {
  if (typeof error === "string") return error;
  const text = [error.code, error.message].filter((part) => part !== undefined && part !== "").join(": ");
  const described = text || JSON.stringify(error);
  return error.key ? `${described} (key ${error.key})` : described;
}

/** Format all errors of a write response, "Unknown error" when the server gave none. */
export function formatWriteErrors(errors: Record<string, ZoteroWriteError | string>): string {
  return Object.values(errors).map(formatWriteError).join("; ") || "Unknown error";
}
