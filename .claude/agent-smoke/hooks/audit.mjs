#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook for the agent smoke test: appends every Zotero tool call and every Bash
// command with its result to agent-audit/audit.jsonl, the evidence test/live/verify-claims.mjs checks
// independently of the agent's claims. Each entry gets a sequential call_no, returned to the agent as additional
// context: claims.json references audited calls by that number instead of re-typing their arguments. Never blocks.
import { append, nextCallNo, readStdin, responseText } from "./lib.mjs";

const input = readStdin();
const name = String(input.tool_name ?? "");
if (name.startsWith("mcp__zotero__") || name === "Bash") try {
  const failure = input.hook_event_name === "PostToolUseFailure";
  const response = input.tool_response;
  const callNo = nextCallNo(input);
  append(input, "audit.jsonl", {
    event: input.hook_event_name,
    call_no: callNo,
    tool_use_id: input.tool_use_id,
    tool_name: name,
    tool_input: input.tool_input,
    is_error: failure || response?.isError === true || response?.is_error === true,
    text: failure ? String(input.error ?? responseText(response)) : responseText(response),
  });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: failure ? "PostToolUseFailure" : "PostToolUse",
        additionalContext: `audit call_no ${callNo} (${name}): reference this call in claims.json as "call_no": ${callNo}`,
      },
    })
  );
} catch (e) {
  process.stderr.write(`audit hook: ${e instanceof Error ? e.message : String(e)}\n`);
}
