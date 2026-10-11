#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook for the agent smoke test: appends every Zotero tool call and every Bash
// command with its result to agent-audit/audit.jsonl, the evidence test/live/verify-claims.mjs checks
// independently of the agent's claims. Never blocks.
import { append, readStdin, responseText } from "./lib.mjs";

const input = readStdin();
const name = String(input.tool_name ?? "");
if (name.startsWith("mcp__zotero__") || name === "Bash") try {
  const failure = input.hook_event_name === "PostToolUseFailure";
  const response = input.tool_response;
  append(input, "audit.jsonl", {
    event: input.hook_event_name,
    tool_use_id: input.tool_use_id,
    tool_name: name,
    tool_input: input.tool_input,
    is_error: failure || response?.isError === true || response?.is_error === true,
    text: failure ? String(input.error ?? responseText(response)) : responseText(response),
  });
} catch (e) {
  process.stderr.write(`audit hook: ${e instanceof Error ? e.message : String(e)}\n`);
}
