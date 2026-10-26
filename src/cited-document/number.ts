import { CitationRequest } from "../citation-injector/model.js";

/**
 * Numera le citazioni per gli stili numerici (ieee/vancouver): ogni chiave prende il numero della sua
 * prima comparsa nel testo; una chiave ripetuta mantiene lo stesso numero. Per una citazione con più voci
 * il `num` è "n1,n2" nell'ordine delle chiavi. Restituisce la stringa `num` per ciascuna richiesta, così
 * il testo provvisorio ([1], [1,2]) combacia con quello che Zotero scriverà al Refresh.
 */
export function assignNumbers(requests: CitationRequest[]): Map<CitationRequest, string> {
  const order = new Map<string, number>();
  for (const r of requests) for (const k of r.keys) if (!order.has(k)) order.set(k, order.size + 1);
  const out = new Map<CitationRequest, string>();
  for (const r of requests) out.set(r, r.keys.map((k) => order.get(k)).join(","));
  return out;
}
