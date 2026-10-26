import { CitationRequest, PreparedCitation } from "../citation-injector/model.js";

/** Un pezzo di testo in linea, con eventuale grassetto/corsivo, oppure una citazione. */
export type Inline =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean }
  | { kind: "cite"; request: CitationRequest };

/** Un blocco del documento: titolo (con livello), paragrafo o voce di elenco. */
export interface Block {
  type: "heading" | "paragraph" | "list-item";
  level?: number;
  inlines: Inline[];
}

export interface ParsedMarkdown {
  blocks: Block[];
  warnings: string[];
}

/** Come Inline, ma le citazioni sono già risolte (per lo scrittore di formato). */
export type ResolvedInline =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean }
  | { kind: "cite"; prepared: PreparedCitation };

export interface ResolvedBlock {
  type: "heading" | "paragraph" | "list-item";
  level?: number;
  inlines: ResolvedInline[];
}
