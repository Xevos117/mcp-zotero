#!/usr/bin/env node
// Builds the Claude Desktop extension (MCP Bundle, .mcpb): clean tsc build, then a staging directory with only
// what the bundle needs (manifest.json, package.json, LICENSE, README.md, build/ and the production dependencies,
// installed with `npm ci --omit=dev --ignore-scripts`), packed with the pinned @anthropic-ai/mcpb.
// The staging directory is outside the repository, so nothing from the working tree (src/, test/, run outputs,
// .env files) can end up in the bundle; .mcpbignore is a second guard applied by `mcpb pack`.
// Usage: node scripts/build-mcpb.mjs [output.mcpb]   (default dist/mcp-zotero.mcpb)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packExtension } from "@anthropic-ai/mcpb";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "dist", "mcp-zotero.mcpb"));
const STAGED = ["manifest.json", "package.json", "package-lock.json", "LICENSE", "README.md", ".mcpbignore", "build"];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);
  process.exit(1);
}

rmSync(join(root, "build"), { recursive: true, force: true });
execFileSync(npm, ["run", "build"], { cwd: root, stdio: "inherit", timeout: 180_000 });

const stage = mkdtempSync(join(tmpdir(), "mcp-zotero-mcpb-"));
try {
  for (const entry of STAGED) cpSync(join(root, entry), join(stage, entry), { recursive: true });
  execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
    timeout: 300_000,
  });
  mkdirSync(dirname(output), { recursive: true });
  if (!(await packExtension({ extensionPath: stage, outputPath: output, silent: true }))) {
    console.error("mcpb pack failed");
    process.exitCode = 1;
  } else {
    console.log(`bundle: ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MiB)`);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
