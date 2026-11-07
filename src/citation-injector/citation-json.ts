import { randomUUID } from "node:crypto";
import { CslItemData, ZoteroCitationItem, ZoteroCslCitation } from "../types/csl-types.js";
import { CitationRequest } from "./model.js";

/**
 * Parte neutra rispetto al formato della citazione: la costruzione delle voci CSL (itemData + URI) e del
 * JSON CSL_CITATION che Zotero legge. La usano sia i campi Word (field-codes.ts) sia i reference mark ODT.
 */

const CSL_SCHEMA_URL = "https://github.com/citation-style-language/schema/raw/master/csl-citation.json";

/** Voci `citationItems` di una citazione: una per chiave, con URI Zotero e itemData. */
export function buildCitationItems(
  request: CitationRequest,
  cslData: Map<string, CslItemData>,
  libraryType: string,
  userId: string
): ZoteroCitationItem[] {
  return request.keys.map((key, idx) => {
    const itemData = cslData.get(key) ?? { type: "article-journal" };
    const uri = `http://zotero.org/${libraryType}s/${userId}/items/${key}`;
    const item: ZoteroCitationItem = {
      id: idx,
      uris: [uri],
      uri: [uri],
      itemData,
    };
    if (request.locator) item.locator = request.locator;
    if (request.prefix) item.prefix = request.prefix;
    if (request.suffix) item.suffix = request.suffix;
    if (request.suppressAuthor) item["suppress-author"] = true;
    return item;
  });
}

/** Oggetto CSL_CITATION (citationID casuale, formattedCitation, citationItems, schema). */
export function buildCslCitation(
  citationItems: ZoteroCitationItem[],
  formattedText: string
): ZoteroCslCitation {
  return {
    citationID: randomUUID().slice(0, 8),
    properties: { formattedCitation: formattedText },
    citationItems,
    schema: CSL_SCHEMA_URL,
  };
}
