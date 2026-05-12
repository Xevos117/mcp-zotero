import { getLibraryType } from "./library-context.js";
interface FulltextPutResult {
  success: boolean;
  error?: string;
}

export async function putFulltext(
  userId: string,
  itemKey: string,
  apiKey: string,
  content: string,
  totalPages: number
): Promise<FulltextPutResult> {
  const url = `https://api.zotero.org/${getLibraryType()}s/${userId}/items/${itemKey}/fulltext`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Zotero-API-Key": apiKey,
    },
    body: JSON.stringify({
      content,
      indexedPages: totalPages,
      totalPages,
    }),
  });

  if (response.status === 204) {
    return { success: true };
  }

  if (response.status === 413) {
    return {
      success: false,
      error: "Fulltext content too large for Zotero API (status 413). The PDF text may exceed the fulltext size limit.",
    };
  }

  return {
    success: false,
    error: `Fulltext PUT failed with status ${response.status}`,
  };
}
