#!/usr/bin/env node
// PreToolUse hook on mcp__zotero__update_item / create_note for the agent smoke test: the key it targets
// (item_key for update_item, parent_item_key for create_note) must be one this run created (read from the
// audit log the PostToolUse hook writes); malformed keys and group writes outside the test library are
// denied. Same pattern as delete-guard. Run settings come from agent-audit/context.json (written by
// prepare.mjs where the agent cannot edit it). A hook error denies.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditDir, createdKeys, writeDecision, deny, readJsonl, readStdin } from "./lib.mjs";

const input = readStdin();
if (input.tool_name === undefined || /^mcp__zotero__(update_item|create_note)$/.test(String(input.tool_name))) {
  let problem;
  try {
    const dir = auditDir(input);
    const contextPath = join(dir, "context.json");
    const context = existsSync(contextPath) ? JSON.parse(readFileSync(contextPath, "utf8")) : null;
    problem = writeDecision(input.tool_name, input.tool_input, context, createdKeys(readJsonl(join(dir, "audit.jsonl"))));
  } catch (e) {
    problem = `hook error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (problem) deny(input, `Denied by the agent smoke harness: ${problem}. Write only to what this run created.`);
}
