import { unescapeXml } from "./xml-utils.js";
import { CitationRequest } from "./model.js";

/**
 * Trova i tag <zcite .../> nel corpo del documento e li traduce in CitationRequest neutre. Lavora sul
 * testo con l'escape XML (lo stesso in `w:t` di Word e in ODF), così è condiviso tra i formati.
 *
 * Tollera `keys="A, B"`: uno spazio di troppo diventerebbe parte della chiave (404 in fetch), quindi le
 * chiavi vengono ripulite. I valori degli attributi hanno un secondo unescape perché il tag è a sua volta
 * XML (p.es. un locator `pp. 12 &amp; 15`).
 */
export function parseZciteTags(documentXml: string): CitationRequest[] {
  const findRegex = /&lt;zcite\s+[\s\S]*?\/&gt;/g;
  const requests: CitationRequest[] = [];
  let findMatch: RegExpExecArray | null;

  while ((findMatch = findRegex.exec(documentXml)) !== null) {
    const fullMatch = findMatch[0];
    const cleanTag = unescapeXml(fullMatch);

    const attrRegex = /(\w+)="([^"]*)"/g;
    const attrs: Record<string, string> = {};
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(cleanTag)) !== null) {
      attrs[attrMatch[1]] = unescapeXml(attrMatch[2]);
    }

    const keys = (attrs["keys"] ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) continue;

    requests.push({
      raw: fullMatch,
      keys,
      locator: attrs["locator"] || undefined,
      prefix: attrs["prefix"] || undefined,
      suffix: attrs["suffix"] || undefined,
      num: attrs["num"] || undefined,
    });
  }
  return requests;
}
