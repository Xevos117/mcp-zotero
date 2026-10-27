import JSZip from "jszip";
import { DocumentFormat, PreparedCitation } from "../model.js";
import { DocumentPrefsOutcome, ZoteroFieldType } from "../document-prefs.js";

/**
 * Scrittore specifico di formato. Il nucleo comune (pipeline.ts) orchestra l'iniezione in modo neutro e
 * delega allo scrittore tutto ciò che dipende dal formato: quale parte del pacchetto è il corpo, come si
 * normalizza, come si scrive una citazione, come si sostituisce un segnaposto, come si aggiunge la
 * bibliografia e come si scrivono le preferenze del documento.
 *
 * `formats/docx.ts` è un semplice involucro sulle funzioni Word di oggi (normalizer, field-codes, prefs),
 * così il percorso docx non cambia comportamento. `formats/odt.ts` (PR D) implementa la stessa interfaccia
 * per i reference mark di LibreOffice.
 */
export interface FormatWriter {
  readonly format: DocumentFormat;
  readonly fieldType: ZoteroFieldType;
  /** Parte del pacchetto che contiene il corpo (es. "word/document.xml", "content.xml"). */
  readonly bodyPart: string;
  /** Nome dell'applicazione per i messaggi all'utente ("Word", "LibreOffice"). */
  readonly app: string;
  /** Messaggio quando il pacchetto non è apribile come zip. */
  invalidPackageMessage(detail: string): string;
  /** Messaggio quando manca la parte del corpo. */
  readonly bodyMissingMessage: string;
  /** Controllo del contenuto/estensione (opzionale): lancia InjectionError("format_mismatch") in caso di conflitto. */
  sniff?(zip: JSZip): void;
  /** Unisce i tag <zcite> spezzati tra più run/span. */
  normalize(bodyXml: string): string;
  /** Unisce i marcatori Pandoc `[@…]` spezzati tra più run/span (ramo pandoc di inject_citations). */
  normalizePandoc?(bodyXml: string): string;
  /** XML della citazione (campo Word o reference mark ODT) per una citazione risolta. */
  citationXml(prepared: PreparedCitation): string;
  /** Sostituisce il segnaposto `rawTag` nel corpo con `citationXml`; ritorna il corpo invariato se non lo trova. */
  replaceTag(bodyXml: string, rawTag: string, citationXml: string): string;
  /** Aggiunge la bibliografia al corpo. */
  appendBibliography(bodyXml: string): string;
  /** Scrive le preferenze del documento nel pacchetto. */
  writePrefs(zip: JSZip, style: string): Promise<DocumentPrefsOutcome>;
  /** Avvisi corrispondenti all'esito delle preferenze. */
  prefsWarnings(outcome: DocumentPrefsOutcome): string[];
  /** Ultimo ritocco al pacchetto prima di salvarlo (odt: mimetype STORED, manifest). */
  finalize?(zip: JSZip): Promise<void>;
  /** Opzioni per JSZip.generateAsync specifiche del formato (odt: niente compressione globale forzata). */
  readonly generateOptions?: Record<string, unknown>;
  /** Pacchetto vuoto e valido su cui costruire un documento da zero (create_cited_document, PR G). */
  skeleton?(): Promise<JSZip>;
}
