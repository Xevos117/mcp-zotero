// Builds the checklist docx (single, multi, locator+prefix, repeated item) and injects it through the
// built mcp-zotero server over stdio with the stub fetch. Usage: node gen.mjs <outdir>
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import JSZip from "jszip";

const out = resolve(process.argv[2] ?? "out");
await mkdir(out, { recursive: true });
const here = new URL(".", import.meta.url).pathname;

const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const cite = (text, tag) =>
  `<w:p><w:r><w:t xml:space="preserve">${text} </w:t></w:r><w:r><w:t>${tag.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")}</w:t></w:r><w:r><w:t xml:space="preserve">.</w:t></w:r></w:p>`;

async function makeDocx(path, numbered) {
  const n = (v) => (numbered ? ` num="${v}"` : "");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      p("Word checklist PoC.") +
      cite("Single", `<zcite keys="AAAA1111"${n(1)}/>`) +
      cite("Multi", `<zcite keys="BBBB2222,CCCC3333"${n("2,3")}/>`) +
      cite("Locator and prefix", `<zcite keys="AAAA1111" locator="12" prefix="see"${n(1)}/>`) +
      cite("Repeat", `<zcite keys="BBBB2222"${n(2)}/>`) +
      p("References") +
      "</w:body></w:document>"
  );
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
}

function inject(file, style) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--import", join(here, "stub.mjs"), join(here, "../../build/server.js")], {
      cwd: join(here, "../.."),
      env: { PATH: process.env.PATH, ZOTERO_API_KEY: "fake", ZOTERO_USER_ID: "000000" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error("timeout")); }, 20000);
    let buf = "", err = "";
    child.stderr.on("data", (d) => (err += d));
    const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    child.stdout.on("data", (c) => {
      buf += c;
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          send(2, "tools/call", { name: "inject_citations", arguments: { file_path: file, style } });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg);
          msg.result?.isError ? rej(new Error(text + err)) : res(JSON.parse(text));
        }
      }
    });
    send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "poc", version: "0" } });
  });
}

for (const [style, numbered] of [["apa", false], ["ieee", true]]) {
  const file = join(out, `checklist-${style}.docx`);
  await makeDocx(file, numbered);
  const r = await inject(file, style);
  console.log(`injected ${style}: ${r.output_path}`, r.warnings?.length ? r.warnings : "");
}
