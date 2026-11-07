// Structural check of the docx -> LibreOffice -> docx round trip (#37): after a separate headless LibreOffice opens
// a Field .docx produced by the Word path and saves it back as .docx, the Zotero field codes and document
// preferences must survive. Not a render check: only that LibreOffice did not drop the codes on a docx round trip.
// Exit 1 (with reasons on stderr) if any of ZOTERO_ITEM, ZOTERO_BIBL (field codes) or ZOTERO_PREF_1 (custom
// property) is missing. JSON summary on stdout.
// Usage: node roundtrip-check.mjs <converted.docx>
import { readFile } from "node:fs/promises";
import JSZip from "jszip";

export async function roundtripProblems(path) {
  const zip = await JSZip.loadAsync(await readFile(path));
  const document = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const custom = (await zip.file("docProps/custom.xml")?.async("string")) ?? "";
  const facts = {
    zoteroItem: (document.match(/ZOTERO_ITEM/g) ?? []).length,
    zoteroBibl: (document.match(/ZOTERO_BIBL/g) ?? []).length,
    prefField: /ZOTERO_PREF_1/.test(custom),
  };
  const problems = [];
  if (!facts.zoteroItem) problems.push("no ZOTERO_ITEM field codes after the round trip");
  if (!facts.zoteroBibl) problems.push("no ZOTERO_BIBL field code after the round trip");
  if (!facts.prefField) problems.push("ZOTERO_PREF_1 custom property lost after the round trip");
  return { facts, problems };
}

if (process.argv[1] && process.argv[1].endsWith("roundtrip-check.mjs")) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: roundtrip-check.mjs <converted.docx>");
    process.exit(2);
  }
  const { facts, problems } = await roundtripProblems(path);
  console.log(JSON.stringify({ roundtrip: facts, problems }, null, 2));
  if (problems.length) {
    for (const p of problems) console.error(`lo-proxy roundtrip: ${p}`);
    process.exitCode = 1;
  }
}
