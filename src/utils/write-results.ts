import { ZoteroItemData, ZoteroWriteError, ZoteroWriteResponse } from "../types/zotero-types.js";

/** Zotero Web API limit on the number of objects in a single write request. */
export const MAX_OBJECTS_PER_WRITE = 50;

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

export interface BatchedWriteResult {
  /** Written objects with their index in the original payload list, in index order. */
  created: Array<{ index: number; entity: ZoteroItemData }>;
  failed: Array<{ index: number; error: string }>;
}

/**
 * POST `payloads` in batches of MAX_OBJECTS_PER_WRITE and map every result back to its index in
 * `payloads`: getData() and getErrors() are indexed by position within each request, and getData()
 * also returns the objects that failed. A batch whose request throws marks its objects as failed;
 * the error is rethrown only when every batch threw, i.e. nothing was written at all.
 */
export async function postInBatches(
  post: (batch: unknown[]) => Promise<ZoteroWriteResponse>,
  payloads: unknown[]
): Promise<BatchedWriteResult> {
  const result: BatchedWriteResult = { created: [], failed: [] };
  let firstError: unknown;
  let anyResponse = false;

  for (let offset = 0; offset < payloads.length; offset += MAX_OBJECTS_PER_WRITE) {
    const batch = payloads.slice(offset, offset + MAX_OBJECTS_PER_WRITE);
    let response: ZoteroWriteResponse;
    try {
      response = await post(batch);
    } catch (err) {
      firstError ??= err;
      const error = err instanceof Error ? err.message : String(err);
      batch.forEach((_, i) => result.failed.push({ index: offset + i, error }));
      continue;
    }
    anyResponse = true;

    const errors = response.getErrors();
    const data = response.getData();
    batch.forEach((_, i) => {
      const index = offset + i;
      if (i in errors) {
        result.failed.push({ index, error: formatWriteError(errors[i]) });
      } else if (data[i]?.key) {
        result.created.push({ index, entity: data[i] });
      } else {
        result.failed.push({ index, error: "Zotero response did not include an item key" });
      }
    });
  }

  if (!anyResponse && payloads.length > 0) throw firstError;
  return result;
}
