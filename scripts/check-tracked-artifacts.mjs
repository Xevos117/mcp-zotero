#!/usr/bin/env node
// CI guard: fails if run outputs are tracked by git. Local live/agent runs write library content (titles, keys,
// collection names, user ids) to agent-out/, agent-audit/, .vitest/ and live-artifacts/; .gitignore excludes them,
// but a branch that predates the ignore entries (or a `git add -f`) can still commit them.
// Two checks: no tracked path under those directories (at any depth), and no tracked file that looks like run
// evidence (audit or denial log, agent context, claims, transcript, live report or summary), wherever it was moved.
// Usage: node scripts/check-tracked-artifacts.mjs   (exit 1 with the offending paths, never their content)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FORBIDDEN_DIR = /(?:^|\/)(agent-out|agent-audit|\.vitest|live-artifacts)\//;
// Files the runs write, recognised by JSON text with quoted keys (also escaped inside another JSON string);
// source and tests build these objects in code, never as JSON text. Each entry: reason, patterns that must all match.
const Q = '\\\\?"'; // " or \"
const key = (k) => `${Q}${k}${Q}:\\s*`;
const EVIDENCE = [
  ["audit log line", [new RegExp(`${key("tool_name")}${Q}mcp__zotero__`)]],
  ["agent context", [new RegExp(`${key("run_tag")}${Q}mzt-run:`)]],
  ["hook denial log", [new RegExp(`${key("reason")}${Q}Denied by the agent smoke harness`)]],
  ["agent claims", [new RegExp(key("schema_version")), new RegExp(key("scenarios")), new RegExp(`${key("run_id")}${Q}[0-9a-z]{8,9}-[0-9a-f]{4}${Q}`)]],
  ["agent transcript", [new RegExp(key("session_id")), /mcp__zotero__/]],
  ["live summary", [new RegExp(key("disposable")), new RegExp(key("leftover"))]],
  ["live report", [new RegExp(key("numTotalTestSuites")), /\.live\.test\.ts/]],
];

/** Offending tracked paths, each with the reason. `read(path)` returns the file content as text. */
export function trackedArtifactProblems(files, read) {
  const problems = [];
  for (const f of files) {
    const dir = FORBIDDEN_DIR.exec(f);
    if (dir) {
      problems.push(`${f}: run output under ${dir[1]}/`);
      continue;
    }
    let text;
    try {
      text = read(f);
    } catch {
      continue; // unreadable (e.g. a submodule entry): nothing to scan
    }
    const hit = EVIDENCE.find(([, patterns]) => patterns.every((re) => re.test(text)));
    if (hit) problems.push(`${f}: looks like run evidence (${hit[0]})`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const problems = trackedArtifactProblems(files, (f) => readFileSync(f, "utf8"));
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error("Remove them from the index (git rm --cached) and keep them ignored: they may hold library content.");
    process.exit(1);
  }
  console.log(`no run outputs tracked (${files.length} files checked)`);
}
