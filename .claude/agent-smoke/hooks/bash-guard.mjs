#!/usr/bin/env node
// PreToolUse hook on Bash for the agent smoke test: the only commands allowed are the wrappers the
// test-mcp-zotero skill uses (make-docx, inject, prompts), in their exact shape. No chaining, pipes, redirections, substitutions, variables,
// env prefixes, other interpreters, node options or paths outside agent-out/. Anything else is denied with the
// reason, before Claude Code's own permission rules (which stay as a second layer). A hook error denies.
import { bashDecision, deny, readStdin, BASH_USAGE } from "./lib.mjs";

const input = readStdin();
if (input.tool_name === undefined || input.tool_name === "Bash") {
  let problem;
  try {
    problem = bashDecision(input.tool_input);
  } catch (e) {
    problem = `hook error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (problem) deny(input, `Denied by the agent smoke harness (${problem}). ${BASH_USAGE}`);
}
