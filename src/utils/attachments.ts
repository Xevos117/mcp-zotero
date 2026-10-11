import { ZoteroApiInterface, ZoteroItemData } from "../types/zotero-types.js";
import { LibraryType } from "./library-context.js";
import { asArray } from "./pagination.js";

export function isPdfAttachment(item: ZoteroItemData): boolean {
  return item.itemType === "attachment" && item.contentType === "application/pdf";
}

/**
 * A link to a PDF on the web (linkMode "linked_url"): Zotero stores no file for it, so it has no
 * full text on the server and cannot be opened or indexed in Zotero desktop.
 */
export function isLinkedUrl(item: ZoteroItemData): boolean {
  return item.linkMode === "linked_url";
}

/** All PDF attachments (stored files and links) among the children of an item. */
export async function findPdfAttachments(
  zoteroApi: ZoteroApiInterface,
  library: { type: LibraryType; id: string },
  itemKey: string
): Promise<ZoteroItemData[]> {
  const response = await zoteroApi.library(library.type, library.id).items(itemKey).children().get();
  return asArray(response.getData()).filter(isPdfAttachment);
}

/** First PDF attachment among the children of an item, if any. */
export async function findPdfAttachment(
  zoteroApi: ZoteroApiInterface,
  library: { type: LibraryType; id: string },
  itemKey: string
): Promise<ZoteroItemData | undefined> {
  return (await findPdfAttachments(zoteroApi, library, itemKey))[0];
}
