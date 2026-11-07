import { XMLParser, XMLBuilder } from "fast-xml-parser";

/**
 * Pre-elabora content.xml di un .odt per unire i tag <zcite> che LibreOffice ha spezzato tra più
 * `text:span` (p.es. per un cambio di formato a metà tag), così parseZciteTags e lo scrittore ODT li
 * trovano contigui. Analogo a zcite-normalizer.ts per Word.
 *
 * I commenti (office:annotation) e le note (text:note) sono esclusi come in Word: un <zcite> lì dentro
 * non viene iniettato. Un `text:s text:c="n"` vale n spazi nell'estrazione del testo.
 *
 * Se non trova tag spezzati restituisce la stringa originale invariata (zero rischio di differenze di
 * round-trip nell'XML).
 */

const ZCITE_PATTERN = /&lt;zcite\s+[\s\S]*?\/&gt;/;
// A complete Pandoc bracketed citation inside one text node (no tag `<`); see zcite-normalizer.ts.
const PANDOC_PATTERN = /\[[^\]<]*@[^\]<]*\]/;

interface FxpNode {
  [tag: string]: unknown;
  ":@"?: Record<string, string>;
  "#text"?: string;
}
type FxpChildren = FxpNode[];

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
};
const BUILDER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: false,
  format: false,
  suppressEmptyNode: false,
  suppressBooleanAttributes: false,
};

/** Sottoalberi da non toccare: commenti e note. */
const MASKED = new Set(["office:annotation", "text:note"]);

/** Testo visibile di un text:span: #text diretti più `text:s text:c=n` come n spazi. */
function extractSpanText(spanChildren: FxpChildren): string {
  let text = "";
  for (const child of spanChildren) {
    if ("#text" in child) text += String(child["#text"]);
    else if ("text:s" in child) {
      const c = Number(child[":@"]?.["@_text:c"] ?? "1");
      text += " ".repeat(Number.isFinite(c) && c > 0 ? c : 1);
    }
  }
  return text;
}

function isSpan(node: FxpNode): boolean {
  return "text:span" in node;
}

/** Un text:span che porta del testo (ha #text o text:s). */
function spanHasText(spanChildren: FxpChildren): boolean {
  return spanChildren.some((c) => "#text" in c || "text:s" in c);
}

interface SpanGroup {
  startIndex: number;
  endIndex: number;
  texts: string[];
}

/** Gruppi di text:span consecutivi (con testo) figli diretti di un text:p/text:h. */
function collectConsecutiveSpanGroups(children: FxpChildren): SpanGroup[] {
  const groups: SpanGroup[] = [];
  let current: SpanGroup | null = null;
  const flush = () => {
    if (current && current.texts.length >= 2) groups.push(current);
    current = null;
  };
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isSpan(child) && spanHasText(child["text:span"] as FxpChildren)) {
      const text = extractSpanText(child["text:span"] as FxpChildren);
      if (current) {
        current.endIndex = i;
        current.texts.push(text);
      } else {
        current = { startIndex: i, endIndex: i, texts: [text] };
      }
      continue;
    }
    flush();
  }
  flush();
  return groups;
}

/** Trova un <zcite> che attraversa più span del gruppo; ritorna l'intervalo [startOffset,endOffset]. */
function findSplitZcite(group: SpanGroup, pattern: RegExp): { startOffset: number; endOffset: number } | null {
  const { texts } = group;
  for (let start = 0; start < texts.length; start++) {
    let concat = "";
    for (let end = start; end < texts.length; end++) {
      concat += texts[end];
      if (end <= start) continue;
      const m = pattern.exec(concat);
      if (m) {
        const matchStart = m.index;
        const matchEnd = m.index + m[0].length;
        const lastStart = concat.length - texts[end].length;
        if (matchStart < lastStart && matchEnd > lastStart) return { startOffset: start, endOffset: end };
      }
    }
  }
  return null;
}

/** Unisce gli span [absStart..absEnd] in uno solo (attributi del primo, testo concatenato come #text). */
function mergeSpansInPlace(children: FxpChildren, group: SpanGroup, startOffset: number, endOffset: number): void {
  const absStart = group.startIndex + startOffset;
  const absEnd = group.startIndex + endOffset;
  const count = absEnd - absStart + 1;
  let merged = "";
  for (let i = absStart; i <= absEnd; i++) merged += extractSpanText(children[i]["text:span"] as FxpChildren);
  const newSpan: FxpNode = { "text:span": [{ "#text": merged }] };
  const firstAttrs = children[absStart][":@"];
  if (firstAttrs) newSpan[":@"] = firstAttrs;
  children.splice(absStart, count, newSpan);
}

function normalizeParagraph(children: FxpChildren, pattern: RegExp): boolean {
  let modified = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of collectConsecutiveSpanGroups(children)) {
      const split = findSplitZcite(group, pattern);
      if (split) {
        mergeSpansInPlace(children, group, split.startOffset, split.endOffset);
        modified = true;
        changed = true;
        break;
      }
    }
  }
  return modified;
}

function walk(nodes: FxpChildren, pattern: RegExp): boolean {
  let modified = false;
  for (const node of nodes) {
    const tag = Object.keys(node).find((k) => k !== ":@" && k !== "#text");
    if (tag && MASKED.has(tag)) continue; // non toccare commenti e note
    if (tag === "text:p" || tag === "text:h") {
      if (normalizeParagraph(node[tag] as FxpChildren, pattern)) modified = true;
    }
    for (const key of Object.keys(node)) {
      if (key === ":@" || key === "#text") continue;
      const value = node[key];
      if (Array.isArray(value) && walk(value as FxpChildren, pattern)) modified = true;
    }
  }
  return modified;
}

function normalizeOdt(contentXml: string, pattern: RegExp, quick: string): string {
  if (!contentXml.includes(quick)) return contentXml;
  const parsed = new XMLParser(PARSER_OPTIONS).parse(contentXml) as FxpChildren;
  if (!walk(parsed, pattern)) return contentXml;
  return new XMLBuilder(BUILDER_OPTIONS).build(parsed) as string;
}

export function normalizeOdtZciteTags(contentXml: string): string {
  return normalizeOdt(contentXml, ZCITE_PATTERN, "zcite");
}

/** Merge Pandoc `[@…]` markers split across text:span in an ODT, mirror of normalizePandocMarkers. */
export function normalizeOdtPandocMarkers(contentXml: string): string {
  if (!contentXml.includes("[") || !contentXml.includes("@")) return contentXml;
  return normalizeOdt(contentXml, PANDOC_PATTERN, "[");
}
