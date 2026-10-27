import { ZoteroApiInterface, ZoteroItemData, isZoteroApiError } from "../types/zotero-types.js";
import { CslItemData } from "../types/csl-types.js";
import { zoteroItemToCsl } from "../utils/csl-to-zotero.js";
import { LibraryType } from "../utils/library-context.js";
import { ItemSource, InjectionResult, injectFile } from "./pipeline.js";
import { CitekeyLookup, CitekeyMatch, itemCitekeys } from "./citekey-resolver.js";
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
 * CitekeyLookup per il server: per ogni citekey Pandoc interroga la libreria (`q=<citekey>` su tutti i
 * campi, Extra compreso) e conferma lato client la corrispondenza esatta sul campo nativo `citationKey` o
 * sulla riga `Citation Key:` di Extra, così un token che compare altrove non produce un falso positivo.
 * Restituisce le chiavi Zotero che portano quel citekey (0 = assente, 2+ = ambiguo).
 */
export function zoteroCitekeyLookup(zoteroApi: ZoteroApiInterface, libraryType: LibraryType, userId: string): CitekeyLookup {
  return async (citekeys) => {
    const out = new Map<string, CitekeyMatch>();
    for (const citekey of citekeys) {
      // Search all fields (Extra included) for the citekey and confirm the exact (case-sensitive) match
      // client-side. qmode=everything also searches full text, so the right item can be past the first
      // page: page until an exact match is found, at most 5 pages (500 results). Citekeys that differ only
      // in case are collected as suggestions for the "not found" error.
      const exact = new Set<string>();
      const similar = new Set<string>();
      const lower = citekey.toLowerCase();
      for (let page = 0; page < 5; page++) {
        const response = await zoteroApi
          .library(libraryType, userId)
          .items()
          .get({ q: citekey, qmode: "everything", limit: 100, start: page * 100 });
        const items = (response.getData() as ZoteroItemData[]) ?? [];
        for (const it of items) {
          for (const ck of itemCitekeys(it as Record<string, unknown>)) {
            if (ck === citekey && typeof it.key === "string") exact.add(it.key);
            else if (ck.toLowerCase() === lower) similar.add(ck);
          }
        }
        if (exact.size > 0 || items.length < 100) break;
      }
      out.set(citekey, { keys: [...exact], similar: [...similar] });
    }
    return out;
  };
}

/**
 * Sostituisce i segnaposto <zcite> di un documento con le citazioni native di Zotero (field code Word per
 * docx, reference mark LibreOffice per odt) e aggiunge la bibliografia. Involucro del nucleo comune
 * (pipeline + scrittore di formato). `format` di default docx: il percorso Word non cambia. Se il
 * documento non ha <zcite> ma marcatori Pandoc `[@…]`, usa il ramo pandoc (risoluzione dei citekey inclusa).
 */
export async function injectCitations(
  filePath: string,
  zoteroApi: ZoteroApiInterface,
  libraryType: LibraryType,
  userId: string,
  style: string,
  format: DocumentFormat = "docx"
): Promise<InjectionResult> {
  return injectFile(
    filePath,
    WRITERS[format] ?? docxWriter,
    zoteroItemSource(zoteroApi, libraryType, userId),
    { libraryType, userId, style },
    zoteroCitekeyLookup(zoteroApi, libraryType, userId)
  );
}
