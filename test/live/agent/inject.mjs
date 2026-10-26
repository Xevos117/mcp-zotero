#!/usr/bin/env node
// Wrapper around the product skill's inject.js for the agent smoke test: input, metadata and output
// must all be inside agent-out/, so the only shell command the agent may run cannot read or write
// anywhere else. Same arguments as inject.js:
//   node test/live/agent/inject.mjs agent-out/<in>.docx agent-out/<out>.docx agent-out/<metadata>.json <library_path> [style]
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../skills/zotero-skill-mcp-integrations/scripts/inject.js", import.meta.url));
const root = resolve("agent-out");
const inside = (p, exts) => typeof p === "string" && resolve(p).startsWith(root + sep) && exts.some((e) => resolve(p).endsWith(e));
// --format è opzionale e viene passato così com'è allo script della skill
const rawArgs = process.argv.slice(2);
const fmtAt = rawArgs.indexOf("--format");
const formatArgs = fmtAt >= 0 ? rawArgs.slice(fmtAt, fmtAt + 2) : [];
const positional = fmtAt >= 0 ? [...rawArgs.slice(0, fmtAt), ...rawArgs.slice(fmtAt + 2)] : rawArgs;
const [input, output, metadata, library, style] = positional;
const DOC = [".docx", ".odt"];

if (!inside(input, DOC) || !inside(output, DOC) || !inside(metadata, [".json"]) || !/^(users|groups)\/\d+$|^\d+$/.test(library ?? "")) {
  console.error("usage: inject.mjs agent-out/<in>.(docx|odt) agent-out/<out>.(docx|odt) agent-out/<metadata>.json <users/ID|groups/ID> [style] [--format docx|odt] (paths inside agent-out/)");
  process.exit(2);
}
const r = spawnSync(process.execPath, [SCRIPT, input, output, metadata, library, ...(style ? [style] : []), ...formatArgs], { stdio: "inherit", timeout: 60_000 });
if (r.error) console.error(`inject.mjs: ${r.error.message}`);
process.exit(r.status ?? 1);
