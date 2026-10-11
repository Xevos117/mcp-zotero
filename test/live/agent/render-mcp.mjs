#!/usr/bin/env node
// Renders test/live/agent/mcp.template.json (the single MCP configuration of the agent smoke test) into a
// concrete file: ${VAR} / ${VAR:-default} replaced from this process's environment, `node` and relative
// script paths made absolute. CI writes the result to $RUNNER_TEMP with mode 600, so the Zotero key is in that
// file only and never in the agent's environment. Locally Claude Code expands the same ${VAR} itself:
// `claude --mcp-config test/live/agent/mcp.template.json`.
// Usage: node test/live/agent/render-mcp.mjs <output.json>   (exit 1 if a variable without default is unset)
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATE = fileURLToPath(new URL("./mcp.template.json", import.meta.url));

/** Template with every ${VAR} / ${VAR:-default} replaced from env; throws on a missing variable without default. */
export function renderMcpConfig(template, env, cwd) {
  const missing = [];
  const expand = (value) =>
    value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return "";
    });
  const config = JSON.parse(template);
  for (const server of Object.values(config.mcpServers ?? {})) {
    if (server.command === "node") server.command = process.execPath;
    server.args = (server.args ?? []).map((a) => {
      const v = expand(a);
      return v.endsWith(".js") && !isAbsolute(v) ? resolve(cwd, v) : v;
    });
    // empty optional values (e.g. no UNPAYWALL_EMAIL) are left out rather than passed as ""
    server.env = Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, expand(v)]).filter(([, v]) => v !== ""));
  }
  if (missing.length) throw new Error(`missing environment variable(s): ${[...new Set(missing)].join(", ")}`);
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: render-mcp.mjs <output.json>");
    process.exit(2);
  }
  try {
    writeFileSync(out, JSON.stringify(renderMcpConfig(readFileSync(TEMPLATE, "utf8"), process.env, process.cwd())), { mode: 0o600 });
    console.log(`MCP config written to ${out}`);
  } catch (e) {
    console.error(`render-mcp: ${e.message}`);
    process.exit(1);
  }
}
