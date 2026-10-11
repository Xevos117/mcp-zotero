#!/usr/bin/env node
// Writes a minimal valid .docx with <zcite> placeholders for the test-mcp-zotero skill, so the agent
// needs no general-purpose shell. Output must be inside agent-out/.
// Usage: node test/live/agent/make-docx.mjs agent-out/<name>.docx [agent-out/<other>.docx ...] '<spec>'
// Every output gets the same content (one document per style, since inject_citations always writes <name>_cited.docx).
// spec: JSON array of paragraphs; each paragraph is an array of runs:
//   "plain text"
//   {"zcite": {"keys": "KEY1,KEY2", "num": "1", "locator": "p. 3", "prefix": "see ", "suffix": "x"}}  own run
//   {"zcite": {...}, "before": "text ", "after": " text"}  inline: text and tag in one run, mid-sentence
//   {"zcite": {...}, "split": true}  the tag split across three runs with different formatting, as Word does
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import JSZip from "jszip";

const argv = process.argv.slice(2);
const specText = argv.length >= 2 ? argv[argv.length - 1] : undefined;
const outs = argv.slice(0, -1);
const root = resolve("agent-out");
const valid = (out) => resolve(out).startsWith(root + sep) && resolve(out).endsWith(".docx");
if (!specText || outs.length === 0 || !outs.every(valid)) {
  console.error("usage: make-docx.mjs agent-out/<name>.docx [agent-out/<other>.docx ...] '<json spec>' (outputs must be .docx inside agent-out/)");
  process.exit(2);
}
let spec;
try {
  spec = JSON.parse(specText);
} catch (e) {
  console.error(`make-docx: spec is not valid JSON (${e.message})`);
  process.exit(2);
}
if (!Array.isArray(spec) || !spec.every(Array.isArray)) {
  console.error("make-docx: spec must be an array of paragraphs, each an array of runs");
  process.exit(2);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ATTRS = ["keys", "num", "locator", "prefix", "suffix"];
const run = (text, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const SPLIT_RPR = ['<w:rPr><w:lang w:val="en-US"/></w:rPr>', '<w:rPr><w:lang w:val="it-IT"/></w:rPr>', '<w:rPr><w:noProof/></w:rPr>'];
function tag(z) {
  if (!z || typeof z.keys !== "string" || !z.keys) return null;
  if (ATTRS.some((a) => String(z[a] ?? "").includes('"'))) return null;
  return `<zcite ${ATTRS.filter((a) => z[a] !== undefined).map((a) => `${a}="${z[a]}"`).join(" ")}/>`;
}
function renderRun(r) {
  if (typeof r === "string") return run(r);
  const t = tag(r?.zcite);
  if (!t) throw new Error(`invalid run ${JSON.stringify(r)} (zcite needs a string "keys"; attribute values cannot contain ")`);
  if (r.split) {
    // e.g. <zcite keys=" | "KEY1,KEY2" num="1 | "/>: the normalizer must rejoin it
    const a = t.indexOf('"') + 1;
    const b = t.length - 3;
    return [t.slice(0, a), t.slice(a, b), t.slice(b)].map((part, i) => run(part, SPLIT_RPR[i])).join("");
  }
  if (r.before !== undefined || r.after !== undefined) return run(`${r.before ?? ""}${t}${r.after ?? ""}`);
  return run(t);
}
let body;
try {
  body = spec.map((runs) => `<w:p>${runs.map(renderRun).join("")}</w:p>`).join("");
} catch (e) {
  console.error(`make-docx: ${e.message}`);
  process.exit(2);
}

const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
);
zip.file(
  "_rels/.rels",
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
);
zip.file(
  "word/document.xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`
);
const buffer = await zip.generateAsync({ type: "nodebuffer" });
for (const out of outs) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), buffer);
}
console.log(JSON.stringify({ outputs: outs, paragraphs: spec.length }));
