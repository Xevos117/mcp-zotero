#!/usr/bin/env node
// Prepares agent-out/ for the test-mcp-zotero skill (CI and local use the same files):
//   agent-out/context.json   run id/tag/prefix, mode, safe mode, group, cleanup owner
//   agent-out/diff.txt       changed files + patch against the base (truncated), for the targeted path
// Usage: node test/live/agent/prepare.mjs [--mode ci|local] [--base <git-ref>] [--run-id <id>]
// Env: ZOTERO_LIVE_SAFE_MODE=1, ZOTERO_TEST_GROUP_ID, AGENT_UNSAFE_OPERATIONS (default items).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "agent-out";
const MAX_PATCH_BYTES = 100_000;
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const mode = arg("mode", "local");
if (!["ci", "local"].includes(mode)) throw new Error(`--mode must be ci or local, got ${mode}`);
// Same format as the live suite (<timestamp base36>-<hex>), so the stale sweep can date it
const runId = arg("run-id", `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`);
if (!/^[0-9a-z]+-[0-9a-f]+$/.test(runId)) throw new Error(`invalid run id ${runId}`);
const base = arg("base", "origin/main");
const safeMode = process.env.ZOTERO_LIVE_SAFE_MODE === "1";
const unsafe = process.env.AGENT_UNSAFE_OPERATIONS || "items";
if (safeMode && unsafe === "all") throw new Error("safe mode: UNSAFE_OPERATIONS=all is not allowed");

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    return `(git ${args.join(" ")} failed: ${e.message.split("\n")[0]})\n`;
  }
};

mkdirSync(OUT, { recursive: true });
const context = {
  schema_version: 1,
  run_id: runId,
  run_tag: `mzt-run:${runId}`,
  prefix: `mzt-${runId}`,
  mode,
  safe_mode: safeMode,
  unsafe_operations: unsafe,
  group_id: (!safeMode && process.env.ZOTERO_TEST_GROUP_ID) || null,
  // in CI the deterministic verifier checks the claimed state, then the workflow deletes the run
  cleanup: mode === "ci" ? "verifier" : "agent",
  base,
  created_at: new Date().toISOString(),
};
writeFileSync(join(OUT, "context.json"), JSON.stringify(context, null, 2) + "\n");

const names = git("diff", "--name-status", `${base}...HEAD`);
let patch = git("diff", "--unified=2", `${base}...HEAD`);
if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) patch = patch.slice(0, MAX_PATCH_BYTES) + "\n[... patch truncated ...]\n";
writeFileSync(join(OUT, "diff.txt"), `# Changed files (${base}...HEAD)\n${names}\n# Patch\n${patch}`);
console.log(`agent-out prepared: run ${runId}, mode ${mode}, safe mode ${safeMode}, base ${base}`);
