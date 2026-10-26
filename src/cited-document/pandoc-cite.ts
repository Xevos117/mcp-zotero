import { CitationRequest } from "../citation-injector/model.js";
import { ZOTERO_KEY } from "../utils/zotero-keys.js";
import { Inline } from "./model.js";

/**
 * Riconosce le citazioni in stile pandoc dentro un testo e lo spezza in pezzi di testo e citazioni:
 *   [@K]              una citazione
 *   [@K1; @K2]        una citazione con due voci
 *   [see @K, p. 12]   prefisso "see", locator "p. 12"
 *   -@K   @K          soppressione dell'autore / citazione in linea
 * Le chiavi non vengono validate qui: resolveCitations rifiuta quelle non valide con lo stesso errore di
 * inject_citations.
 */

const LOCATOR_RE = /^(?:p{1,2}\.|pp?\b|pages?\b|chap\.?|ch\.|sec\.?|§|fig\.?|no\.?|vol\.?|art\.?)/i;

/** Una voce dentro le parentesi: `-?@KEY` con eventuale testo prima (prefix) e dopo (locator o suffix). */
function parseBracket(inner: string): CitationRequest | null {
  const parts = inner.split(";");
  const keys: string[] = [];
  let prefix: string | undefined;
  let suffix: string | undefined;
  let locator: string | undefined;
  let suppressAuthor = false;
  for (const part of parts) {
    const mm = /(-?)@([A-Za-z0-9]+)/.exec(part);
    if (!mm) continue;
    keys.push(mm[2]);
    if (parts.length === 1) {
      const before = part.slice(0, mm.index).trim();
      if (before) prefix = before;
      suppressAuthor = mm[1] === "-";
      const after = part.slice(mm.index + mm[0].length).replace(/^,\s*/, "").trim();
      if (after) {
        if (LOCATOR_RE.test(after)) locator = after;
        else suffix = after;
      }
    }
  }
  if (keys.length === 0) return null;
  return { keys, prefix, suffix, locator, suppressAuthor, raw: `[${inner}]` };
}

export function parseCites(text: string, onWarning: (msg: string) => void = () => {}): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  // una citazione tra parentesi che contiene @, oppure una citazione in linea -@K / @K. Come pandoc, una
  // citazione in linea comincia solo a inizio testo o dopo un carattere non alfanumerico: così "a@b.com"
  // (una email) non viene scambiato per la citazione "@b".
  const re = /\[([^\]]*@[^\]]*)\]|(?<![A-Za-z0-9])(-?)@([A-Za-z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      const req = parseBracket(m[1]);
      if (req) out.push({ kind: "cite", request: req });
      else out.push({ kind: "text", text: m[0] });
    } else if (ZOTERO_KEY.test(m[3])) {
      out.push({ kind: "cite", request: { keys: [m[3]], suppressAuthor: m[2] === "-", raw: m[0] } });
    } else {
      // una @parola in linea che non è una chiave Zotero ben formata resta testo, con un avviso (mai un errore)
      out.push({ kind: "text", text: m[0] });
      onWarning(`"${m[0]}" is not a well-formed Zotero item key (8 characters from 23456789ABCDEFGHIJKLMNPQRSTUVWXYZ); kept as text`);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
