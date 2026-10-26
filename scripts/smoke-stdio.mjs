#!/usr/bin/env node
// Stdio smoke test for the built server, run once against a user library and once against a
// group library (ZOTERO_LIBRARY_TYPE=group): initialize, tools/list, get_collections and
// inject_citations through the real zotero-api-client (fetch stubbed, fake credentials, no network).
// With --bundle the server is the one inside a Claude Desktop extension (.mcpb): the bundle is unpacked outside
// the repository (so no dependency resolves from the repo's node_modules) and started with the command, args and
// env that @anthropic-ai/mcpb derives from its manifest.json and the user_config values, as a client would.
// Usage: node scripts/smoke-stdio.mjs [--dump <file>] [--bundle <file.mcpb>]
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";

const EXPECTED_TOOLS = 18;
const EXPECTED_PROMPTS = 4;
const TIMEOUT_MS = 20_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stub = fileURLToPath(new URL("./smoke-fetch-stub.mjs", import.meta.url));
const dumpIdx = process.argv.indexOf("--dump");
const dumpFile = dumpIdx >= 0 ? process.argv[dumpIdx + 1] : undefined;
const bundleIdx = process.argv.indexOf("--bundle");
const bundleFile = bundleIdx >= 0 ? process.argv[bundleIdx + 1] : undefined;
const FAKE_API_KEY = "smoke-fake-key";

const SCENARIOS = [
  { name: "user", env: { ZOTERO_USER_ID: "000000" }, prefix: "/users/000000" },
  {
    name: "group",
    env: { ZOTERO_USER_ID: "000000", ZOTERO_LIBRARY_TYPE: "group", ZOTERO_LIBRARY_ID: "777" },
    prefix: "/groups/777",
  },
];

async function makeDocx(dir) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t xml:space="preserve">Claim </w:t></w:r><w:r><w:t>&lt;zcite keys="SMKITEM2"/&gt;</w:t></w:r></w:p>' +
      "</w:body></w:document>"
  );
  const path = join(dir, "smoke.docx");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

async function makeOdt(dir) {
  const NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';
  const MIME = "application/vnd.oasis.opendocument.text";
  const zip = new JSZip();
  zip.file("mimetype", MIME, { compression: "STORE" });
  zip.file(
    "META-INF/manifest.xml",
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
      `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIME}"/>` +
      '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
      '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
      '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>'
  );
  zip.file("content.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:body><office:text><text:p>Claim &lt;zcite keys="SMKITEM2"/&gt;</text:p></office:text></office:body></office:document-content>`);
  zip.file("styles.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:styles/></office:document-styles>`);
  zip.file("meta.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${NS}><office:meta/></office:document-meta>`);
  const path = join(dir, "smoke.odt");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return path;
}

/** Controllo strutturale leggero dell'odt iniettato (il validatore completo è test/helpers/citation-validate.ts). */
async function checkOdt(buffer, expectedUri) {
  const b = Buffer.from(buffer);
  if (b.readUInt32LE(0) !== 0x04034b50 || b.toString("latin1", 30, 38) !== "mimetype" || b.readUInt16LE(8) !== 0) {
    throw new Error("odt: mimetype must be the first, STORED entry");
  }
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("content.xml")?.async("string");
  if (!xml) throw new Error("odt part missing: content.xml");
  if (XMLValidator.validate(xml) !== true) throw new Error("content.xml is not well-formed");
  if (/&lt;zcite\b/.test(xml)) throw new Error("<zcite> placeholder left in the odt");
  if (!xml.includes("text:reference-mark-start")) throw new Error("odt: no reference mark injected");
  if (!/ZOTERO_BIBL [\s\S]*CSL_BIBLIOGRAPHY/.test(decodeXml(xml))) throw new Error("odt: no ZOTERO_BIBL section");
  if (!decodeXml(xml).includes(expectedUri)) throw new Error(`odt: expected URI ${expectedUri} not found`);
  const meta = decodeXml((await zip.file("meta.xml")?.async("string")) ?? "");
  if (!/ZOTERO_PREF_1[\s\S]*fieldType" value="ReferenceMark"/.test(meta)) throw new Error("odt: ZOTERO_PREF with ReferenceMark not in meta.xml");
}

const decodeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Structural check of the injected docx, dependency-light (the full validator with CSL schemas and
// citeproc is test/helpers/docx-validate.ts): package parts, well-formed XML, balanced fields,
// parseable CSL JSON, Zotero URIs, visible text = formattedCitation, one bibliography field, Zotero document
// preferences (ZOTERO_PREF_1 with the apa style and fieldType Field, declared in the package).
async function checkDocx(buffer, expectedUri) {
  const zip = await JSZip.loadAsync(buffer);
  for (const part of ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]) {
    if (!zip.file(part)) throw new Error(`docx part missing: ${part}`);
  }
  const xml = await zip.file("word/document.xml").async("string");
  if (XMLValidator.validate(xml) !== true) throw new Error("word/document.xml is not well-formed");
  if (/&lt;zcite\b/.test(xml)) throw new Error("<zcite> placeholder left in the document");
  const tokens = xml.matchAll(/w:fldCharType="(begin|separate|end)"|<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g);
  const fields = [];
  let open = null;
  for (const [, kind, instr, text] of tokens) {
    if (kind === "begin") {
      if (open) throw new Error("nested or unterminated field");
      open = { instr: "", result: "", state: "instr" };
    } else if (kind === "separate") {
      if (open?.state !== "instr") throw new Error("fldChar separate out of order");
      open.state = "result";
    } else if (kind === "end") {
      if (open?.state !== "result") throw new Error("fldChar end out of order");
      fields.push(open);
      open = null;
    } else if (instr !== undefined && open?.state === "instr") open.instr += decodeXml(instr);
    else if (text !== undefined && open?.state === "result") open.result += decodeXml(text);
  }
  if (open) throw new Error("unterminated field");
  const cites = fields.filter((f) => f.instr.trim().startsWith("ADDIN ZOTERO_ITEM CSL_CITATION "));
  const bibs = fields.filter((f) => f.instr.trim().startsWith("ADDIN ZOTERO_BIBL "));
  if (cites.length !== 1 || bibs.length !== 1) throw new Error(`expected 1 citation + 1 bibliography field, got ${cites.length} + ${bibs.length}`);
  const json = JSON.parse(cites[0].instr.trim().slice("ADDIN ZOTERO_ITEM CSL_CITATION ".length));
  const uris = json.citationItems?.flatMap((ci) => ci.uris ?? []) ?? [];
  if (uris.length !== 1 || uris[0] !== expectedUri) throw new Error(`citation uris ${JSON.stringify(uris)} != [${expectedUri}]`);
  if (!/^http:\/\/zotero\.org\/(users|groups)\/\d+\/items\/[A-Z0-9]{8}$/.test(uris[0])) throw new Error(`malformed URI ${uris[0]}`);
  if (!json.citationItems[0].itemData?.type) throw new Error("citation without itemData.type");
  if (json.properties?.formattedCitation !== cites[0].result) {
    throw new Error(`formattedCitation ${JSON.stringify(json.properties?.formattedCitation)} != visible ${JSON.stringify(cites[0].result)}`);
  }
  const custom = decodeXml((await zip.file("docProps/custom.xml")?.async("string")) ?? "");
  if (!/name="ZOTERO_PREF_1"/.test(custom)) throw new Error("docProps/custom.xml without ZOTERO_PREF_1 (Zotero document preferences)");
  if (!custom.includes('<style id="http://www.zotero.org/styles/apa"') || !custom.includes('<pref name="fieldType" value="Field"/>')) {
    throw new Error("ZOTERO_PREF: not the apa style with fieldType Field");
  }
  const types = await zip.file("[Content_Types].xml").async("string");
  const rels = await zip.file("_rels/.rels").async("string");
  if (!types.includes('PartName="/docProps/custom.xml"') || !rels.includes("relationships/custom-properties")) {
    throw new Error("docProps/custom.xml not declared in [Content_Types].xml and _rels/.rels");
  }
}

/** How to start the server for a scenario: the built server of the repository, or the unpacked bundle. */
async function serverLaunch({ env }, bundle) {
  if (!bundle) {
    return { args: ["build/server.js"], cwd: root, env: { ZOTERO_API_KEY: FAKE_API_KEY, ...env } };
  }
  const { getMcpConfigForManifest } = await import("@anthropic-ai/mcpb");
  const userConfig = {
    zotero_api_key: FAKE_API_KEY,
    zotero_user_id: env.ZOTERO_USER_ID,
    ...(env.ZOTERO_LIBRARY_TYPE ? { zotero_library_type: env.ZOTERO_LIBRARY_TYPE } : {}),
    ...(env.ZOTERO_LIBRARY_ID ? { zotero_library_id: env.ZOTERO_LIBRARY_ID } : {}),
  };
  const home = join(bundle.dir, "..");
  const config = await getMcpConfigForManifest({
    manifest: bundle.manifest,
    extensionPath: bundle.dir,
    systemDirs: { HOME: home, DESKTOP: home, DOCUMENTS: home, DOWNLOADS: home },
    userConfig,
    pathSeparator: sep,
  });
  if (!config) throw new Error("bundle: no MCP config from the manifest (required user_config missing?)");
  if (JSON.stringify(config).includes("${")) throw new Error(`bundle: unresolved variable in ${JSON.stringify(config)}`);
  // Clients run "node" with their own Node.js runtime: here, the one running this script
  if (config.command !== "node") throw new Error(`bundle: unexpected command ${config.command}`);
  return { args: config.args, cwd: bundle.dir, env: config.env };
}

function runScenario({ name, prefix }, launch, docxPath, odtPath) {
  return new Promise((resolveScenario, rejectScenario) => {
    const child = spawn(process.execPath, ["--import", stub, ...launch.args], {
      cwd: launch.cwd,
      env: { PATH: process.env.PATH, SMOKE_LIBRARY_PREFIX: prefix, ...launch.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let done = false;
    child.stderr.on("data", (d) => (stderr += d));

    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      child.kill("SIGKILL");
      if (err) rejectScenario(new Error(`[${name}] ${err}${stderr ? `\nserver stderr:\n${stderr}` : ""}`));
      else resolveScenario(value);
    };
    const killTimer = setTimeout(() => finish(`timeout after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
    child.on("exit", (code) => finish(`server exited early (code ${code})`));

    const pending = new Map();
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish(`non JSON-RPC output on stdout: ${line.slice(0, 200)}`);
        }
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });

    let nextId = 1;
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result)));
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    (async () => {
      const init = await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      });
      if (init.serverInfo?.version !== pkg.version) {
        throw new Error(`serverInfo.version ${init.serverInfo?.version} != package.json ${pkg.version}`);
      }
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const { tools } = await request("tools/list", {});
      if (tools.length !== EXPECTED_TOOLS) throw new Error(`expected ${EXPECTED_TOOLS} tools, got ${tools.length}`);
      for (const tool of tools) {
        const schema = tool.inputSchema;
        if (!tool.description) throw new Error(`${tool.name}: missing description`);
        if (schema?.type !== "object" || typeof schema.properties !== "object") throw new Error(`${tool.name}: invalid inputSchema`);
      }

      const { prompts } = await request("prompts/list", {});
      if (prompts.length !== EXPECTED_PROMPTS) throw new Error(`expected ${EXPECTED_PROMPTS} prompts, got ${prompts.length}`);
      for (const prompt of prompts) {
        if (!prompt.name || !prompt.description) throw new Error(`prompt ${prompt.name}: missing name/description`);
      }
      const gotPrompt = await request("prompts/get", { name: "import_references", arguments: { dois: "10.1/smoke" } });
      const promptText = gotPrompt.messages?.[0]?.content?.text ?? "";
      if (!promptText.includes("10.1/smoke") || !promptText.includes("add_items_by_doi")) {
        throw new Error(`prompts/get import_references unexpected text: ${promptText.slice(0, 200)}`);
      }

      const collections = await request("tools/call", { name: "get_collections", arguments: {} });
      const collectionsText = collections.content?.[0]?.text ?? "";
      if (collections.isError || !collectionsText.includes("SMOKE001")) {
        throw new Error(`get_collections unexpected result: ${collectionsText.slice(0, 300)}`);
      }

      const injected = await request("tools/call", { name: "inject_citations", arguments: { file_path: docxPath } });
      const injectedText = injected.content?.[0]?.text ?? "";
      if (injected.isError) throw new Error(`inject_citations failed: ${injectedText.slice(0, 300)}`);
      const { output_path } = JSON.parse(injectedText);
      await checkDocx(await readFile(output_path), `http://zotero.org${prefix}/items/SMKITEM2`);

      // LibreOffice (.odt): stesso percorso, reference mark invece dei field code
      const injectedOdt = await request("tools/call", { name: "inject_citations", arguments: { file_path: odtPath } });
      const injectedOdtText = injectedOdt.content?.[0]?.text ?? "";
      if (injectedOdt.isError) throw new Error(`inject_citations (odt) failed: ${injectedOdtText.slice(0, 300)}`);
      await checkOdt(await readFile(JSON.parse(injectedOdtText).output_path), `http://zotero.org${prefix}/items/SMKITEM2`);

      return { init, tools, prompts };
    })().then(
      (value) => finish(null, value),
      (err) => finish(err.message)
    );
  });
}

/** Unpack the bundle outside the repository and check what it contains. */
async function unpackBundle(file, workDir) {
  const { unpackExtension } = await import("@anthropic-ai/mcpb");
  const dir = join(workDir, "extension");
  if (!(await unpackExtension({ mcpbPath: file, outputDir: dir, silent: true }))) throw new Error(`cannot unpack ${file}`);
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  if (manifest.version !== pkg.version) throw new Error(`bundle manifest version ${manifest.version} != package.json ${pkg.version}`);
  const entries = await readdir(dir);
  const unexpected = entries.filter((e) => !["build", "node_modules", "manifest.json", "package.json", "LICENSE", "README.md"].includes(e));
  if (unexpected.length) throw new Error(`bundle: unexpected top-level entries ${unexpected.join(", ")}`);
  // Packages the lockfile marks dev-only (not reachable from the production dependencies) must be absent
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const devOnly = Object.entries(lock.packages).filter(([path, info]) => path && info.dev && existsSync(join(dir, path)));
  if (devOnly.length) throw new Error(`bundle: dev dependencies bundled: ${devOnly.map(([path]) => path).slice(0, 10).join(", ")}`);
  return { dir, manifest };
}

const workDir = await mkdtemp(join(tmpdir(), "mcp-zotero-smoke-"));
try {
  const bundle = bundleFile ? await unpackBundle(bundleFile, workDir) : undefined;
  for (const scenario of SCENARIOS) {
    const docxPath = await makeDocx(workDir);
    const odtPath = await makeOdt(workDir);
    const { init, tools, prompts } = await runScenario(scenario, await serverLaunch(scenario, bundle), docxPath, odtPath);
    if (bundle) {
      const listed = tools.map((t) => t.name).sort().join(",");
      const declared = bundle.manifest.tools.map((t) => t.name).sort().join(",");
      if (listed !== declared) throw new Error(`bundle: tools/list [${listed}] != manifest tools [${declared}]`);
      const listedPrompts = prompts.map((p) => p.name).sort().join(",");
      const declaredPrompts = (bundle.manifest.prompts ?? []).map((p) => p.name).sort().join(",");
      if (listedPrompts !== declaredPrompts) throw new Error(`bundle: prompts/list [${listedPrompts}] != manifest prompts [${declaredPrompts}]`);
    }
    if (dumpFile && scenario.name === "user") {
      const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
      writeFileSync(dumpFile, JSON.stringify({ serverInfo: init.serverInfo, tools: sorted }, null, 2));
    }
    console.log(
      `smoke OK [${bundle ? "bundle " : ""}${scenario.name}]: protocol ${init.protocolVersion}, ${tools.length} tools, ${prompts.length} prompts, ` +
        `get_collections + inject_citations (docx + odt) via ${scenario.prefix}`
    );
  }
} catch (err) {
  console.error(`smoke FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
