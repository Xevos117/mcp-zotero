// Builds the checklist documents from the real corpus (test/fixtures/corpus) and injects them with the built server
// (build/server.js over stdio, fetch replaced by stub.mjs: placeholder libraries only, no network).
// One document per tool style (user library /users/000000) and one APA document from the group library /groups/777.
// Usage: node test/word-proxy/gen.mjs <outdir>   → <outdir>/<name>.docx and <name>_cited.docx
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const manifest = JSON.parse(await readFile(join(ROOT, "test/fixtures/corpus/corpus.json"), "utf8"));
const K = Object.fromEntries(manifest.works.map((w) => [w.id, w.key]));

/** Documents: name, tool style, numbered placeholders, library. */
export const DOCUMENTS = [
  { name: "checklist-apa", style: "apa" },
  { name: "checklist-ieee", style: "ieee", numbered: true },
  { name: "checklist-vancouver", style: "vancouver", numbered: true },
  { name: "checklist-harvard", style: "harvard" },
  { name: "checklist-chicago", style: "chicago" },
  { name: "checklist-apa-group", style: "apa", group: "777" },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
const cite = (text, attrs) => {
  const tag = `<zcite ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;
  return `<w:p><w:r><w:t xml:space="preserve">${esc(text)} </w:t></w:r><w:r><w:t>${esc(tag)}</w:t></w:r><w:r><w:t xml:space="preserve">.</w:t></w:r></w:p>`;
};

/** Citations of the checklist (num = order of first citation, as citeproc numbers them). */
function body(numbered) {
  const n = (v) => (numbered ? { num: v } : {});
  return (
    p("Word checklist (word-proxy): real corpus, refreshed by Zotero.") +
    cite("Single", { keys: K.conneau2020, ...n("1") }) +
    cite("Same first author and year", { keys: `${K.peroni2023a},${K.peroni2023b}`, ...n("2,3") }) +
    cite("Locator and prefix", { keys: K.eve2020, locator: "110", prefix: "see", ...n("4") }) +
    cite("Repeated", { keys: K.conneau2020, ...n("1") }) +
    cite("Edited book and monograph", { keys: `${K.edmond2020},${K.kochan2017}`, ...n("5,6") }) +
    cite("Cyrillic", { keys: K.ivanov2022, ...n("7") }) +
    cite("Preprint, thesis, report, web page", { keys: [K.jiang2023, K.gualandi2022, K.rda2020, K.turingway].join(","), ...n("8-11") }) +
    cite("Same single author and year", { keys: `${K.eve2020},${K.eve2020b}`, ...n("4,12") }) +
    cite("Ampersand in the journal name", { keys: K.ament2025, ...n("13") }) +
    p("References")
  );
}

async function makeDocx(path, numbered) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body(numbered)}<w:sectPr/></w:body></w:document>`);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

/** inject_citations through the built server (one process per call, every wait bounded). */
function inject(file, style, group) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--import", join(HERE, "stub.mjs"), join(ROOT, "build/server.js")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        ZOTERO_API_KEY: "word-proxy-fake-key",
        ZOTERO_USER_ID: "000000",
        ...(group ? { ZOTERO_LIBRARY_TYPE: "group", ZOTERO_LIBRARY_ID: group } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error(`inject ${file}: timeout`));
    }, 30_000);
    let buf = "";
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const send = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    child.stdout.on("data", (c) => {
      buf += c;
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/call", params: { name: "inject_citations", arguments: { file_path: file, style } } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg);
          if (msg.result?.isError) rej(new Error(`inject ${file}: ${text}\n${err}`));
          else res(JSON.parse(text));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "word-proxy", version: "0" } } });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? "word-proxy-docs");
  await mkdir(out, { recursive: true });
  for (const d of DOCUMENTS) {
    const file = join(out, `${d.name}.docx`);
    await makeDocx(file, d.numbered);
    const r = await inject(file, d.style, d.group);
    if (r.citations_injected !== 9 || r.warnings?.length) throw new Error(`${d.name}: ${JSON.stringify(r)}`);
    console.log(`injected ${d.name} (${d.style}${d.group ? `, group ${d.group}` : ""}): ${r.citations_injected} citations`);
  }
}
