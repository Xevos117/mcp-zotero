import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { CslItemData } from "../types/csl-types.js";
import { zoteroItemToCsl } from "../utils/csl-to-zotero.js";
import { LibraryType } from "../utils/library-context.js";
import { ItemSource, InjectionResult, injectFile } from "./pipeline.js";
import { FormatWriter } from "./formats/types.js";
import { docxWriter } from "./formats/docx.js";
import { odtWriter } from "./formats/odt.js";
import { DocumentFormat } from "./model.js";

export type { InjectionResult } from "./pipeline.js";

/** Scrittori per formato: Word (docx) e LibreOffice (odt). */
const WRITERS: Record<DocumentFormat, FormatWriter> = { docx: docxWriter, odt: odtWriter };

/**
 * ItemSource per il server: una GET per chiave dall'API Zotero; una chiave con 404 viene raccolta come
 * assente dal chiamante, ogni altro errore interrompe subito (come prima in fetchCslData).
 */
export function zoteroItemSource(zoteroApi: ZoteroApiInterface, libraryType: LibraryType, userId: string): ItemSource {
  return async (keys) => {
    const cslData = new Map<string, CslItemData>();
    for (const key of keys) {
      let response;
      try {
        response = await zoteroApi.library(libraryType, userId).items(key).get();
      } catch (err) {
        if (isZoteroApiError(err) && err.response?.status === 404) continue;
        throw err;
      }
      const zoteroItem = response.getData() as ZoteroItemData;
      cslData.set(key, zoteroItemToCsl(zoteroItem));
    }
    return cslData;
  };
}

/**
 * Sostituisce i segnaposto <zcite> di un documento con le citazioni native di Zotero (field code Word per
 * docx, reference mark LibreOffice per odt) e aggiunge la bibliografia. Involucro del nucleo comune
 * (pipeline + scrittore di formato). `format` di default docx: il percorso Word non cambia.
 */
export async function injectCitations(
  filePath: string,
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  userId: string,
  style: string,
  format: DocumentFormat = "docx"
): Promise<InjectionResult> {
  return injectFile(filePath, WRITERS[format] ?? docxWriter, zoteroItemSource(zoteroApi, libraryType, userId), {
    libraryType,
    userId,
    style,
  });
}
