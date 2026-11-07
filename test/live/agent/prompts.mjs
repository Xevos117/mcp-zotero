#!/usr/bin/env node
// Read-only MCP prompts wrapper for the agent smoke test. The agent's MCP client exposes tools, not
// prompts, so this spawns the built server over stdio (like scripts/smoke-stdio.mjs) and exercises
// prompts/list or prompts/get, printing the result as JSON. Prompts are static text and never touch
// Zotero, so no real credentials are needed (a placeholder key only lets the server start).
//
//   node test/live/agent/prompts.mjs list
//   node test/live/agent/prompts.mjs get <prompt name> '<json args>'
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const [cmd, name, argsJson] = process.argv.slice(2);

function usage(msg) {
  console.error(`${msg}\nusage: prompts.mjs list | prompts.mjs get <prompt name> ['<json args>']`);
  process.exit(2);
}
if (cmd !== "list" && cmd !== "get") usage("first argument must be 'list' or 'get'");
if (cmd === "get" && !name) usage("'get' needs a prompt name");

let args = {};
if (cmd === "get" && argsJson !== undefined) {
  try {
    args = JSON.parse(argsJson);
  } catch {
    usage(`arguments must be a JSON object, got: ${argsJson}`);
  }
}

const TIMEOUT_MS = 20_000;
const child = spawn(process.execPath, [join(root, "build/server.js")], {
  cwd: root,
  env: {
    ...process.env,
    // Prompts need no Zotero access; a placeholder only lets the server start without a real key.
    ZOTERO_API_KEY: process.env.ZOTERO_API_KEY || "prompts-wrapper-placeholder",
    ZOTERO_USER_ID: process.env.ZOTERO_USER_ID || "0",
  },
  stdio: ["pipe", "pipe", "ignore"],
});

let done = false;
const finish = (err, out) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill("SIGKILL");
  if (err) {
    console.error(`prompts.mjs: ${err}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
};
const timer = setTimeout(() => finish(`timeout after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
child.on("error", (e) => finish(String(e)));
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
      return finish(`non JSON-RPC output: ${line.slice(0, 200)}`);
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
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
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prompts-wrapper", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  if (cmd === "list") {
    const { prompts } = await request("prompts/list", {});
    return { prompts: prompts.map((p) => ({ name: p.name, description: p.description, arguments: (p.arguments ?? []).map((a) => a.name) })) };
  }
  const result = await request("prompts/get", { name, arguments: args });
  return { name, messages: (result.messages ?? []).map((m) => ({ role: m.role, text: m.content?.text ?? "" })) };
})().then(
  (out) => finish(null, out),
  (err) => finish(err instanceof Error ? err.message : String(err))
);
