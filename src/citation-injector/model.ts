import { CslItemData, ZoteroCitationItem } from "../types/csl-types.js";

/** Formato del documento di destinazione. docx = campi Word; odt = reference mark LibreOffice. */
export type DocumentFormat = "docx" | "odt";

/**
 * Richiesta di citazione neutra rispetto al formato: le chiavi e le opzioni della singola voce, come
 * ricavate da un tag <zcite> o da una citazione pandoc. `raw` è il testo del tag così come compare nel
 * corpo (già XML-escapato), usato dallo scrittore per localizzare e sostituire il segnaposto.
 */
export interface CitationRequest {
  keys: string[];
  locator?: string;
  prefix?: string;
  suffix?: string;
  /** Numero di citazione per gli stili numerici (ieee/vancouver). */
  num?: string;
  /** Sopprime l'autore (pandoc `-@chiave`): per ora passato attraverso, usato da G. */
  suppressAuthor?: boolean;
  /**
   * Marcatore Pandoc in linea (`@chiave`/`-@chiave`, senza parentesi). Un inline che non si risolve resta
   * testo con un avviso (non è un errore), a differenza di una forma tra parentesi `[@…]` sconosciuta.
   */
  inline?: boolean;
  /** Testo originale del segnaposto nel corpo, per la sostituzione. */
  raw: string;
}

/**
 * Citazione risolta pronta per la scrittura: la richiesta, le voci CSL costruite (itemData + URI) e il
 * testo visibile provvisorio. Lo scrittore di formato la trasforma nel suo XML (campo Word o reference mark).
 */
export interface PreparedCitation {
  request: CitationRequest;
  items: ZoteroCitationItem[];
  itemData: CslItemData[];
  formattedText: string;
}

export type InjectionErrorCode =
  | "invalid_package"
  | "no_document"
  | "format_mismatch"
  | "invalid_key"
  | "missing_keys"
  | "output_is_input";

/** Errore dell'iniezione con un codice stabile; il messaggio resta quello mostrato all'utente. */
export class InjectionError extends Error {
  constructor(
    public readonly code: InjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "InjectionError";
  }
}
