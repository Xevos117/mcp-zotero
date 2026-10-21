#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook for the agent smoke test: appends every Zotero tool call and every Bash
// command with its result to agent-audit/audit.jsonl, the evidence test/live/verify-claims.mjs checks
// independently of the agent's claims. Each entry gets a sequential call_no, returned to the agent as additional
// context: claims.json references audited calls by that number instead of re-typing their arguments. Every Read of
// a rendered page (agent-render/*.png, visual review) goes to agent-audit/image-reads.jsonl with its own read_no
// (the call_no sequence stays the one of the Zotero and Bash calls): visual-gate.mjs and verify-claims check from it
// that every page was looked at. Never blocks.
import { append, nextCallNo, nextNo, readStdin, renderedPageRead, responseText } from "./lib.mjs";

const input = readStdin();
const name = String(input.tool_name ?? "");
const page = renderedPageRead(input);
if (page) try {
  append(input, "image-reads.jsonl", {
    event: input.hook_event_name,
    read_no: nextNo(input, "read-no"),
    tool_use_id: input.tool_use_id,
    image: page,
    is_error: input.hook_event_name === "PostToolUseFailure",
  });
} catch (e) {
  process.stderr.write(`audit hook: ${e instanceof Error ? e.message : String(e)}\n`);
}
else if (name.startsWith("mcp__zotero__") || name === "Bash") try {
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
