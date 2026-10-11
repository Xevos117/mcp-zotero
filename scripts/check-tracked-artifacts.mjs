#!/usr/bin/env node
// CI guard: fails if run outputs are tracked by git. Local live/agent runs write library content (titles, keys,
// collection names, user ids) to agent-out/, agent-audit/, .vitest/ and live-artifacts/; .gitignore excludes them,
// but a branch that predates the ignore entries (or a `git add -f`) can still commit them.
// Two checks: no tracked path under those directories, and no tracked file that looks like agent evidence
// (an audit log line or an agent context file), wherever it was moved.
// Usage: node scripts/check-tracked-artifacts.mjs   (exit 1 with the offending paths, never their content)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_DIRS = ["agent-out/", "agent-audit/", ".vitest/", "live-artifacts/"];
// written by the hooks of .claude/agent-smoke and by test/live/agent/prepare.mjs, as JSON with quoted keys
// (source and tests build these objects in code, never as JSON text)
const EVIDENCE = [/"tool_name":\s*"mcp__zotero__/, /"run_tag":\s*"mzt-run:/];

/** Offending tracked paths, each with the reason. `read(path)` returns the file content as text. */
export function trackedArtifactProblems(files, read) {
  const problems = [];
  for (const f of files) {
    const dir = FORBIDDEN_DIRS.find((d) => f.startsWith(d));
    if (dir) {
      problems.push(`${f}: run output under ${dir}`);
      continue;
    }
    let text;
    try {
      text = read(f);
    } catch {
      continue; // unreadable (e.g. a submodule entry): nothing to scan
    }
    if (EVIDENCE.some((re) => re.test(text))) problems.push(`${f}: looks like agent run evidence (audit log or agent context)`);
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
