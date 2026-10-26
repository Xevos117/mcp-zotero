// Builds the checklist documents from the real corpus (test/fixtures/corpus) as .odt and injects them with the built
// server (build/server.js over stdio, fetch replaced by the word-proxy stub: placeholder libraries only, no network),
// format "odt". One document per tool style (user library /users/000000) and one APA document from the group library.
// The odt writer is the product's (PR-D feat/odt-libreoffice); the reference-mark format is checked by verify.mjs.
// Usage: node test/lo-proxy/gen.mjs <outdir>   → <outdir>/<name>.odt and <name>_cited.odt
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const STUB = join(ROOT, "test/word-proxy/stub.mjs");
const manifest = JSON.parse(await readFile(join(ROOT, "test/fixtures/corpus/corpus.json"), "utf8"));
const K = Object.fromEntries(manifest.works.map((w) => [w.id, w.key]));

/** Documents: name, tool style, numbered placeholders, library — the same corpus as word-proxy (9 citations each). */
export const DOCUMENTS = [
  { name: "checklist-apa", style: "apa" },
  { name: "checklist-ieee", style: "ieee", numbered: true },
  { name: "checklist-vancouver", style: "vancouver", numbered: true },
  { name: "checklist-harvard", style: "harvard" },
  { name: "checklist-chicago", style: "chicago" },
  { name: "checklist-apa-group", style: "apa", group: "777" },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const p = (t) => `<text:p>${esc(t)}</text:p>`;
// The zcite placeholder is written across two spans, so the product's odt-normalizer has to join them back
const cite = (text, attrs) => {
  const tag = `<zcite ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;
  return `<text:p>${esc(text + " ")}<text:span>${esc(tag)}</text:span>.</text:p>`;
};

/** Citations of the checklist (num = order of first citation, as citeproc numbers them) — mirrors word-proxy gen. */
function body(numbered) {
  const n = (v) => (numbered ? { num: v } : {});
  return (
    p("LibreOffice checklist (lo-proxy): real corpus, refreshed by Zotero.") +
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

const MIMETYPE = "application/vnd.oasis.opendocument.text";

export async function makeOdt(path, numbered) {
  const zip = new JSZip();
  // mimetype must be the first entry and STORED (uncompressed) for a valid ODF package
  zip.file("mimetype", MIMETYPE, { compression: "STORE" });
  zip.file(
    "META-INF/manifest.xml",
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
      `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIMETYPE}"/>` +
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
      '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
      '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
      "</manifest:manifest>"
  );
  const NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';
  zip.file("styles.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS} office:version="1.3"><office:styles/></office:document-styles>`);
  zip.file("meta.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS} office:version="1.3"><office:meta/></office:document-meta>`);
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS} office:version="1.3">` +
      "<office:body><office:text>" +
      body(numbered) +
      "</office:text></office:body></office:document-content>"
  );
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

/** inject_citations through the built server (one process per call, every wait bounded), format odt. */
function inject(file, style, group) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--import", STUB, join(ROOT, "build/server.js")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        ZOTERO_API_KEY: "lo-proxy-fake-key",
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
          send({ id: 2, method: "tools/call", params: { name: "inject_citations", arguments: { file_path: file, style, format: "odt" } } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg);
          if (msg.result?.isError) rej(new Error(`inject ${file}: ${text}\n${err}`));
          else res(JSON.parse(text));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lo-proxy", version: "0" } } });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? "lo-proxy-docs");
  await mkdir(out, { recursive: true });
  for (const d of DOCUMENTS) {
    const file = join(out, `${d.name}.odt`);
    await makeOdt(file, d.numbered);
    const r = await inject(file, d.style, d.group);
    if (r.citations_injected !== 9 || r.warnings?.length) throw new Error(`${d.name}: ${JSON.stringify(r)}`);
    console.log(`injected ${d.name} (${d.style}${d.group ? `, group ${d.group}` : ""}): ${r.citations_injected} citations`);
  }
}
