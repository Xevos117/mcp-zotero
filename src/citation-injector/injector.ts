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

/** Cap on the fallback scan, so resolving an unknown citekey never walks an unbounded library. */
const CITEKEY_SCAN_CAP = 5000;

/** Record an item's citekeys into the exact/similar sets of each requested citekey. */
function indexItemCitekeys(
  item: ZoteroItemData,
  want: Map<string, { exact: Set<string>; similar: Set<string>; lower: string }>
): void {
  const key = typeof item.key === "string" ? item.key : undefined;
  for (const ck of itemCitekeys(item as Record<string, unknown>)) {
    const lc = ck.toLowerCase();
    for (const [requested, w] of want) {
      if (ck === requested) {
        if (key) w.exact.add(key);
      } else if (lc === w.lower) {
        w.similar.add(ck);
      }
    }
  }
}

/**
 * CitekeyLookup per il server. Prima prova la ricerca `q=<citekey>&qmode=everything` (Extra compreso) e
 * conferma lato client il match esatto (case-sensitive) sul campo `citationKey` o sulla riga
 * `Citation Key:` di Extra. Se la ricerca non trova nessun match (l'indice full-text può non aver ancora
 * indicizzato una voce appena creata, o `q` può non coprire Extra), ricade su una SCANSIONE paginata di
 * `items/top` fino a CITEKEY_SCAN_CAP, che legge direttamente i dati delle voci (quindi vede subito anche
 * una voce appena creata) e risolve in una sola passata tutti i citekey ancora mancanti. Un citekey che
 * differisce solo per maiuscole/minuscole è raccolto come suggerimento per l'errore "not found".
 */
export function zoteroCitekeyLookup(zoteroApi: ZoteroApiInterface, libraryType: LibraryType, userId: string): CitekeyLookup {
  return async (citekeys) => {
    const state = new Map<string, { exact: Set<string>; similar: Set<string>; lower: string }>();
    for (const ck of citekeys) state.set(ck, { exact: new Set(), similar: new Set(), lower: ck.toLowerCase() });

    // Pass 1: one search per citekey (qmode=everything includes full text, so page up to 5 pages).
    for (const [citekey, s] of state) {
      for (let page = 0; page < 5; page++) {
        const response = await zoteroApi
          .library(libraryType, userId)
          .items()
          .get({ q: citekey, qmode: "everything", limit: 100, start: page * 100 });
        const items = (response.getData() as ZoteroItemData[]) ?? [];
        for (const it of items) indexItemCitekeys(it, state);
        if (s.exact.size > 0 || items.length < 100) break;
      }
    }

    // Pass 2 (fallback): for the citekeys the search did not resolve, scan items/top directly (reads item
    // data, not the search index), one page, until all are resolved or the cap is reached.
    const unresolved = new Map([...state].filter(([, s]) => s.exact.size === 0));
    if (unresolved.size > 0) {
      let start = 0;
      for (;;) {
        const response = await zoteroApi.library(libraryType, userId).items().top().get({ limit: 100, start });
        const page = (response.getData() as ZoteroItemData[]) ?? [];
        if (page.length === 0) break;
        for (const it of page) indexItemCitekeys(it, unresolved);
        start += page.length;
        if ([...unresolved.values()].every((s) => s.exact.size > 0)) break;
        if (start >= CITEKEY_SCAN_CAP || page.length < 100) break;
      }
    }

    const out = new Map<string, CitekeyMatch>();
    for (const [ck, s] of state) out.set(ck, { keys: [...s.exact], similar: [...s.similar] });
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
