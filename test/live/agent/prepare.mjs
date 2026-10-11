#!/usr/bin/env node
// Prepares agent-out/ for the test-mcp-zotero skill (CI and local use the same files):
//   agent-out/context.json   run id/tag/prefix, mode, safe mode, group, cleanup owner
//   agent-out/diff.txt       changed files + patch against the base (truncated), for the targeted path
//   agent-audit/             emptied; context.json copy for the hooks of .claude/agent-smoke (outside agent-out/,
//                            so the agent cannot edit it), then audit.jsonl / denials.jsonl written by the hooks
// Usage: node test/live/agent/prepare.mjs [--mode ci|local] [--base <git-ref>] [--run-id <id>]
// Env: ZOTERO_LIVE_SAFE_MODE=1, ZOTERO_TEST_GROUP_ID, AGENT_UNSAFE_OPERATIONS (default items).
// CI mode also requires ZOTERO_TEST_API_KEY and ZOTERO_TEST_USERNAME and exits non-zero, before the agent
// starts, unless the key belongs to that user and the library has the __mzt_disposable__ sentinel.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "agent-out";
const AUDIT = "agent-audit";
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

/** CI: the agent may only ever run against the dedicated, disposable test account. */
async function assertDisposableAccount() {
  const key = process.env.ZOTERO_TEST_API_KEY ?? "";
  const expected = process.env.ZOTERO_TEST_USERNAME ?? "";
  if (!key || !expected) throw new Error("CI mode needs ZOTERO_TEST_API_KEY and ZOTERO_TEST_USERNAME");
  const get = async (path) => {
    const r = await fetch(`https://api.zotero.org/${path}`, {
      headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${r.status}`);
    return r.json();
  };
  const me = await get("keys/current");
  if (String(me.username ?? "") !== expected) throw new Error("the Zotero key does not belong to ZOTERO_TEST_USERNAME: refusing to start the agent");
  const lib = `users/${me.userID}`;
  for (let start = 0; ; start += 100) {
    const page = await get(`${lib}/collections?limit=100&start=${start}`);
    if (page.some((c) => c.data?.name === "__mzt_disposable__")) return;
    if (page.length < 100) break;
  }
  throw new Error("no __mzt_disposable__ collection in the test library: refusing to start the agent");
}

if (mode === "ci") {
  if (safeMode) throw new Error("CI mode runs only on the dedicated account, not in safe mode");
  await assertDisposableAccount();
}

/** Group for the agent's group path: only a group named "mzt-test…" (same rule as the live suite), never in safe mode. */
async function verifiedGroupId() {
  const requested = process.env.ZOTERO_TEST_GROUP_ID;
  const key = process.env.ZOTERO_TEST_API_KEY;
  if (!requested || safeMode) return null;
  if (!key) {
    console.warn("ZOTERO_TEST_GROUP_ID ignored: ZOTERO_TEST_API_KEY is needed to verify the group name");
    return null;
  }
  const r = await fetch(`https://api.zotero.org/groups/${encodeURIComponent(requested)}`, {
    headers: { "Zotero-API-Key": key, "Zotero-API-Version": "3" },
    signal: AbortSignal.timeout(30_000),
  });
  const name = r.ok ? String((await r.json())?.data?.name ?? "") : "";
  if (name.startsWith("mzt-test")) return requested;
  console.warn("ZOTERO_TEST_GROUP_ID ignored: group not accessible or its name does not start with mzt-test");
  return null;
}
const groupId = await verifiedGroupId();

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
  group_id: groupId,
  // in CI the deterministic verifier checks the claimed state, then the workflow deletes the run
  cleanup: mode === "ci" ? "verifier" : "agent",
  base,
  created_at: new Date().toISOString(),
};
writeFileSync(join(OUT, "context.json"), JSON.stringify(context, null, 2) + "\n");
rmSync(AUDIT, { recursive: true, force: true });
mkdirSync(AUDIT, { recursive: true });
writeFileSync(join(AUDIT, "context.json"), JSON.stringify(context, null, 2) + "\n");

const names = git("diff", "--name-status", `${base}...HEAD`);
let patch = git("diff", "--unified=2", `${base}...HEAD`);
if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) patch = patch.slice(0, MAX_PATCH_BYTES) + "\n[... patch truncated ...]\n";
writeFileSync(join(OUT, "diff.txt"), `# Changed files (${base}...HEAD)\n${names}\n# Patch\n${patch}`);
console.log(`agent-out prepared: run ${runId}, mode ${mode}, safe mode ${safeMode}, base ${base}`);
