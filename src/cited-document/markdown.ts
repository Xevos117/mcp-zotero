import { Block, Inline, ParsedMarkdown } from "./model.js";
import { parseCites } from "./pandoc-cite.js";

/**
 * Sottoinsieme di markdown sostenuto da create_cited_document: titoli (#…), paragrafi, grassetto (**…**),
 * corsivo (*…* o _…_), elenchi a un livello (- o *). Tutto il resto diventa testo, con un avviso. Le
 * citazioni in stile pandoc nel testo vengono riconosciute da pandoc-cite.
 */

/** Grassetto/corsivo, poi le citazioni dentro ciascun pezzo di testo (che ne eredita lo stile). */
function parseInlines(text: string): Inline[] {
  const segments: Array<{ text: string; bold?: boolean; italic?: boolean }> = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) segments.push({ text: m[2], italic: true });
    else segments.push({ text: m[3], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });

  const out: Inline[] = [];
  for (const s of segments) {
    for (const inl of parseCites(s.text)) {
      if (inl.kind === "text") {
        if (inl.text) out.push({ kind: "text", text: inl.text, bold: s.bold, italic: s.italic });
      } else {
        out.push(inl);
      }
    }
  }
  return out;
}

export function parseMarkdown(md: string): ParsedMarkdown {
  const blocks: Block[] = [];
  const warnings = new Set<string>();
  const lines = md.replace(/\r\n?/g, "\n").split("\n");

  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", inlines: parseInlines(paragraph.join(" ")) });
      paragraph = [];
    }
  };

  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      // blocco di codice: reso come testo
      warnings.add("code blocks are rendered as plain text");
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      flush();
      blocks.push({ type: "paragraph", inlines: [{ kind: "text", text: line }] });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      if (heading[1].length > 6) warnings.add("heading levels deeper than 6 are rendered as level 6");
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 6), inlines: parseInlines(heading[2].trim()) });
      continue;
    }
    const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (item) {
      flush();
      if (item[1].length > 0) warnings.add("nested lists are flattened to one level");
      blocks.push({ type: "list-item", level: 1, inlines: parseInlines(item[2].trim()) });
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      flush();
      warnings.add("ordered lists are rendered as bullet lists");
      blocks.push({ type: "list-item", level: 1, inlines: parseInlines(ordered[1].trim()) });
      continue;
    }
    if (/^\s*>/.test(line)) warnings.add("block quotes are rendered as plain text");
    if (/^\s*\|/.test(line)) warnings.add("tables are rendered as plain text");
    if (/!\[[^\]]*\]\([^)]*\)/.test(line)) warnings.add("images are dropped; their alt text is kept");
    paragraph.push(line.replace(/^\s*>\s?/, "").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"));
  }
  flush();

  return { blocks, warnings: [...warnings] };
}
