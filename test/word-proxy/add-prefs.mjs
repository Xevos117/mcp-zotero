// Candidate product fix: add docProps/custom.xml with ZOTERO_PREF_1 (style + fieldType Field) to a docx.
// Usage: node add-prefs.mjs in.docx out.docx styleURI
import { readFile, writeFile } from "node:fs/promises";
import JSZip from "jszip";
const [inp, out, style] = process.argv.slice(2);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const zip = await JSZip.loadAsync(await readFile(inp));
const data = `<data data-version="3"><session id="mcpzoter"/><style id="${style}" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="0"/><prefs><pref name="fieldType" value="Field"/></prefs></data>`;
zip.file("docProps/custom.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ZOTERO_PREF_1"><vt:lpwstr>${esc(data)}</vt:lpwstr></property></Properties>`);
let ct = await zip.file("[Content_Types].xml").async("string");
ct = ct.replace("</Types>", '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>');
zip.file("[Content_Types].xml", ct);
let rels = await zip.file("_rels/.rels").async("string");
rels = rels.replace("</Relationships>", '<Relationship Id="rIdZp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>');
zip.file("_rels/.rels", rels);
await writeFile(out, await zip.generateAsync({ type: "nodebuffer" }));
