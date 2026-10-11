#!/usr/bin/env node
// PreToolUse hook on mcp__zotero__delete_items / delete_collection for the agent smoke test: every key must be
// one this run created (read from the audit log the PostToolUse hook writes) or a key that exists nowhere
// (ZZZZZZZZ, YYYYYYYY); malformed keys and, in safe mode, delete_collection are denied. Run settings come
// from agent-audit/context.json, written by prepare.mjs where the agent cannot edit it. A hook error denies.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditDir, createdKeys, deleteDecision, deny, readJsonl, readStdin } from "./lib.mjs";

const input = readStdin();
if (input.tool_name === undefined || /^mcp__zotero__delete_/.test(String(input.tool_name))) {
  let problem;
  try {
    const dir = auditDir(input);
    const contextPath = join(dir, "context.json");
    const context = existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : null;
    problem = deleteDecision(input.tool_name, input.tool_input, context, createdKeys(readJsonl(join(dir, "audit.jsonl"))));
  } catch (e) {
    problem = `hook error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (problem) deny(input, `Denied by the agent smoke harness: ${problem}. Delete only what this run created.`);
}
