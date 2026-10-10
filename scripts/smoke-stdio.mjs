#!/usr/bin/env node
// Stdio smoke test for the built server, run once against a user library and once against a
// group library (ZOTERO_LIBRARY_TYPE=group): initialize, tools/list, get_collections and
// inject_citations through the real zotero-api-client (fetch stubbed, fake credentials, no network).
// Usage: node scripts/smoke-stdio.mjs [--dump <file>]
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const EXPECTED_TOOLS = 15;
const TIMEOUT_MS = 20_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("./smoke-fetch-stub.mjs", import.meta.url));
const dumpIdx = process.argv.indexOf("--dump");
const dumpFile = dumpIdx >= 0 ? process.argv[dumpIdx + 1] : undefined;

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
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t xml:space="preserve">Claim </w:t></w:r><w:r><w:t>&lt;zcite keys="SMOKEITM"/&gt;</w:t></w:r></w:p>' +
      "</w:body></w:document>"
  );
  const path = join(dir, "smoke.docx");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

function runScenario({ name, env, prefix }, docxPath) {
  return new Promise((resolveScenario, rejectScenario) => {
    const child = spawn(process.execPath, ["--import", stub, "build/server.js"], {
      cwd: root,
      env: { PATH: process.env.PATH, ZOTERO_API_KEY: "smoke-fake-key", SMOKE_LIBRARY_PREFIX: prefix, ...env },
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
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      const { tools } = await request("tools/list", {});
      if (tools.length !== EXPECTED_TOOLS) throw new Error(`expected ${EXPECTED_TOOLS} tools, got ${tools.length}`);
      for (const tool of tools) {
        const schema = tool.inputSchema;
        if (!tool.description) throw new Error(`${tool.name}: missing description`);
        if (schema?.type !== "object" || typeof schema.properties !== "object") throw new Error(`${tool.name}: invalid inputSchema`);
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
      const outZip = await JSZip.loadAsync(await readFile(output_path));
      const documentXml = await outZip.file("word/document.xml").async("string");
      const expectedUri = `http://zotero.org${prefix}/items/SMOKEITM`;
      if (!documentXml.includes(expectedUri)) throw new Error(`citation field code does not contain ${expectedUri}`);

      return { init, tools };
    })().then(
      (value) => finish(null, value),
      (err) => finish(err.message)
    );
  });
}

const workDir = await mkdtemp(join(tmpdir(), "mcp-zotero-smoke-"));
try {
  for (const scenario of SCENARIOS) {
    const docxPath = await makeDocx(workDir);
    const { init, tools } = await runScenario(scenario, docxPath);
    if (dumpFile && scenario.name === "user") {
      const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
      writeFileSync(dumpFile, JSON.stringify({ serverInfo: init.serverInfo, tools: sorted }, null, 2));
    }
    console.log(
      `smoke OK [${scenario.name}]: protocol ${init.protocolVersion}, ${tools.length} tools, ` +
        `get_collections + inject_citations via ${scenario.prefix}`
    );
  }
} catch (err) {
  console.error(`smoke FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
