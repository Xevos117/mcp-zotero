#!/usr/bin/env node
// Writes a minimal valid .docx with <zcite> placeholders for the test-mcp-zotero skill, so the agent
// needs no general-purpose shell. Output must be inside agent-out/.
// Usage: node test/live/agent/make-docx.mjs agent-out/<name>.docx '<spec>'
// spec: JSON array of paragraphs; each paragraph is an array of runs:
//   "plain text"  or  {"zcite": {"keys": "KEY1,KEY2", "num": "1", "locator": "p. 3", "prefix": "see ", "suffix": "x"}}
// Each zcite gets its own run, as inject_citations and inject.js expect.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import JSZip from "jszip";

const [out, specText] = process.argv.slice(2);
const root = resolve("agent-out");
const target = resolve(out ?? "");
if (!out || !specText || !target.startsWith(root + sep) || !target.endsWith(".docx")) {
  console.error("usage: make-docx.mjs agent-out/<name>.docx '<json spec>' (output must be a .docx inside agent-out/)");
  process.exit(2);
}
const spec = JSON.parse(specText);
if (!Array.isArray(spec)) throw new Error("spec must be an array of paragraphs");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ATTRS = ["keys", "num", "locator", "prefix", "suffix"];
const run = (text) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const paragraph = (runs) =>
  `<w:p>${runs
    .map((r) => {
      if (typeof r === "string") return run(r);
      const z = r?.zcite;
      if (!z?.keys) throw new Error(`invalid run ${JSON.stringify(r)}`);
      if (ATTRS.some((a) => String(z[a] ?? "").includes('"'))) throw new Error('zcite attribute values cannot contain "');
      const attrs = ATTRS.filter((a) => z[a] !== undefined).map((a) => `${a}="${z[a]}"`).join(" ");
      return run(`<zcite ${attrs}/>`);
    })
    .join("")}</w:p>`;

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
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${spec.map(paragraph).join("")}<w:sectPr/></w:body></w:document>`
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, await zip.generateAsync({ type: "nodebuffer" }));
console.log(JSON.stringify({ output: out, paragraphs: spec.length }));
