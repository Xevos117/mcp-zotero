import { ZoteroApiInterface, ZoteroItemData } from "../types/zotero-types.js";
import { LibraryType } from "./library-context.js";
import { asArray } from "./pagination.js";

export function isPdfAttachment(item: ZoteroItemData): boolean {
  return item.itemType === "attachment" && item.contentType === "application/pdf";
}

/** First PDF attachment among the children of an item, if any. */
export async function findPdfAttachment(
  zoteroApi: ZoteroApiInterface,
  library: { type: LibraryType; id: string },
  itemKey: string
): Promise<ZoteroItemData | undefined> {
  const response = await zoteroApi.library(library.type, library.id).items(itemKey).children().get();
  return asArray(response.getData()).find(isPdfAttachment);
}
