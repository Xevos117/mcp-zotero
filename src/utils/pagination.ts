import { ZoteroItemData, ZoteroResponse } from "../types/zotero-types.js";

const PAGE_LIMIT = 100;

/** getData() returns an object for single-item requests and an array otherwise. */
export function asArray<T>(data: T | T[] | null | undefined): T[] {
  return Array.isArray(data) ? data : data ? [data] : [];
}

export interface PaginatedResult {
  items: ZoteroItemData[];
  totalResults: number | null;
}

export async function fetchAllPages(
  buildRequest: (params: Record<string, unknown>) => Promise<ZoteroResponse>
): Promise<PaginatedResult> {
  const firstResponse = await buildRequest({ limit: PAGE_LIMIT, start: 0 });
  const firstData = firstResponse.getData();
  const firstItems = asArray(firstData);

  const totalResults = firstResponse.getTotalResults();

  if (totalResults === null || firstItems.length >= totalResults) {
    return { items: firstItems, totalResults };
  }

  const allItems: ZoteroItemData[] = [...firstItems];

  let start = firstItems.length;
  while (start < totalResults) {
    const response = await buildRequest({ limit: PAGE_LIMIT, start });
    const data = response.getData();
    const pageItems = asArray(data);

    if (pageItems.length === 0) break;

    allItems.push(...pageItems);
    start += pageItems.length;
  }

  return { items: allItems, totalResults };
}

/** Zotero Web API limit on the number of keys in a single `itemKey` filter. */
export const MAX_KEYS_PER_REQUEST = 50;

/**
 * Fetch items by key in chunks of MAX_KEYS_PER_REQUEST, each with an explicit `limit`
 * (the API default page size is 25, so a bare `itemKey` GET silently drops the rest).
 * Returns the items found and the library version of the last response.
 */
export async function fetchItemsByKeys(
  buildRequest: (params: Record<string, unknown>) => Promise<ZoteroResponse>,
  keys: string[]
): Promise<{ items: ZoteroItemData[]; version: number | null }> {
  const items: ZoteroItemData[] = [];
  let version: number | null = null;

  for (let start = 0; start < keys.length; start += MAX_KEYS_PER_REQUEST) {
    const chunk = keys.slice(start, start + MAX_KEYS_PER_REQUEST);
    const response = await buildRequest({ itemKey: chunk.join(","), limit: chunk.length });
    const data = response.getData();
    items.push(...asArray(data));
    version = response.getVersion();
  }

  return { items, version };
}
