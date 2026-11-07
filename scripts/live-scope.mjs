#!/usr/bin/env node
// Scope of a run of the live workflow (live suite + agent smoke test), for its `changes` job:
//   live=true|false   run the live suite (test/live) against the Zotero test account
//   agent=true|false  then run the agent smoke test (only after the live suite passed; it costs API credits)
// Pull requests: decided by the changed files (one path per line on stdin); every change relevant to the agent
// also runs the live suite, so the agent always follows a live run. Push to main and the weekly schedule: live
// suite only. Manual runs: input `scope` (live | live+agent, default live+agent).
// Usage: git diff --name-only BASE...HEAD | EVENT=pull_request node scripts/live-scope.mjs >> "$GITHUB_OUTPUT"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Files that change what the live suite exercises. */
export const LIVE_PATHS =
  /^(src\/|skills\/zotero-skill-mcp-integrations\/|test\/live\/|test\/helpers\/|test\/e2e\/server-process\.ts|test\/fixtures\/|package(-lock)?\.json|tsconfig\.json|vitest\.live\.config\.ts|scripts\/live-scope\.mjs|scripts\/duplicate-run\.mjs|\.github\/workflows\/claude-agent-smoke\.yml)/;

/** Files that change what the agent smoke test exercises, or how it runs (word-render pages included). */
export const AGENT_PATHS =
  /^(src\/|skills\/zotero-skill-mcp-integrations\/|\.claude\/skills\/test-mcp-zotero\/|\.claude\/agent-smoke\/|test\/live\/agent\/|test\/live\/verify-claims\.mjs|test\/live\/lock\.mjs|test\/live\/cleanup\.mjs|test\/live\/global-setup\.ts|test\/live\/scrub-report\.mjs|test\/live\/mask-group-name\.mjs|test\/live\/helpers\/|test\/fixtures\/csl\/|test\/fixtures\/corpus\/|test\/word-proxy\/|test\/lo-proxy\/|\.github\/actions\/(word-tools|libreoffice-tools)\/|test\/e2e\/server-process\.ts|vitest\.live\.config\.ts|test\/helpers\/docx-validate\.ts|package(-lock)?\.json|tsconfig\.json|scripts\/run-agent\.mjs|scripts\/live-scope\.mjs|scripts\/duplicate-run\.mjs|\.github\/agents\/agent-smoke\.json|\.github\/workflows\/claude-agent-smoke\.yml)/;

export const SCOPES = ["live+agent", "live"];

/** @returns {{ live: boolean, agent: boolean }} */
export function liveScope(event, changed = [], scope = "") {
  if (event === "pull_request") {
    const agent = changed.some((f) => AGENT_PATHS.test(f));
    return { live: agent || changed.some((f) => LIVE_PATHS.test(f)), agent };
  }
  if (event === "workflow_dispatch") {
    const s = scope || "live+agent";
    if (!SCOPES.includes(s)) throw new Error(`scope must be one of ${SCOPES.join(", ")}, got ${JSON.stringify(s)}`);
    return { live: true, agent: s === "live+agent" };
  }
  // push to main, schedule
  return { live: true, agent: false };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const event = process.env.EVENT ?? "";
    const changed = event === "pull_request" ? readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
    const { live, agent } = liveScope(event, changed, process.env.SCOPE ?? "");
    process.stdout.write(`live=${live}\nagent=${agent}\n`);
  } catch (e) {
    console.error(`live-scope: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
