#!/usr/bin/env node
// Stdio smoke test for the built server: initialize, tools/list, one tools/call through the
// real zotero-api-client (fetch stubbed, fake credentials, no network).
// Usage: node scripts/smoke-stdio.mjs [--dump <file>]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_TOOLS = 15;
const TIMEOUT_MS = 20_000;
const root = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("./smoke-fetch-stub.mjs", import.meta.url));
const dumpIdx = process.argv.indexOf("--dump");
const dumpFile = dumpIdx >= 0 ? process.argv[dumpIdx + 1] : undefined;

const child = spawn(process.execPath, ["--import", stub, "build/server.js"], {
  cwd: root,
  env: { PATH: process.env.PATH, ZOTERO_API_KEY: "smoke-fake-key", ZOTERO_USER_ID: "000000" },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

function fail(message) {
  console.error(`smoke FAILED: ${message}`);
  if (stderr) console.error(`server stderr:\n${stderr}`);
  child.kill("SIGKILL");
  process.exit(1);
}

const killTimer = setTimeout(() => fail(`timeout after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
child.on("exit", (code) => fail(`server exited early (code ${code})`));

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
      fail(`non JSON-RPC output on stdout: ${line.slice(0, 200)}`);
    }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let nextId = 1;
function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? fail(`${method}: ${JSON.stringify(msg.error)}`) : resolve(msg.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const { tools } = await request("tools/list", {});
if (tools.length !== EXPECTED_TOOLS) fail(`expected ${EXPECTED_TOOLS} tools, got ${tools.length}`);
for (const tool of tools) {
  const schema = tool.inputSchema;
  if (!tool.description) fail(`${tool.name}: missing description`);
  if (schema?.type !== "object" || typeof schema.properties !== "object") fail(`${tool.name}: invalid inputSchema`);
}

const call = await request("tools/call", { name: "get_collections", arguments: {} });
const text = call.content?.[0]?.text ?? "";
if (call.isError || !text.includes("SMOKE001")) fail(`get_collections unexpected result: ${text.slice(0, 300)}`);

if (dumpFile) {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(dumpFile, JSON.stringify({ serverInfo: init.serverInfo, tools: sorted }, null, 2));
}

console.log(`smoke OK: protocol ${init.protocolVersion}, ${tools.length} tools, get_collections via zotero-api-client`);
clearTimeout(killTimer);
child.removeAllListeners("exit");
child.kill();
