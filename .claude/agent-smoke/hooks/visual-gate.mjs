#!/usr/bin/env node
// Stop hook of the agent smoke test: the visual review must rest on every rendered page. When agent-render/index.json
// exists (word-render ran) and some page has no audited Read in agent-audit/image-reads.jsonl (audit.mjs), or
// agent-out/visual-review.md is missing, it blocks the stop ({"decision": "block", "reason": …}, Claude Code Stop hook
// contract) and names what is missing, so the agent reads the pages and updates the review. At most MAX_BLOCKS
// times per run (agent-audit/stop-blocks.jsonl), then it lets the agent stop and verify-claims decides.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { append, auditDir, projectDir, readJsonl, readStdin, renderedPages, runId, unreadPages } from "./lib.mjs";

export const MAX_BLOCKS = 2;
const input = readStdin();
try {
  const pages = renderedPages(input);
  if (pages) {
    const run = runId(input);
    const blocks = readJsonl(join(auditDir(input), "stop-blocks.jsonl")).filter((b) => b.run_id === run).length;
    const unread = unreadPages(pages, readJsonl(join(auditDir(input), "image-reads.jsonl")), run);
    const review = existsSync(join(projectDir(input), "agent-out", "visual-review.md"));
    if ((unread.length || !review) && blocks < MAX_BLOCKS) {
      const missing = [
        ...(unread.length ? [`read these rendered pages with the Read tool (agent-render/<page>): ${unread.join(", ")}`] : []),
        ...(review ? [] : ["write agent-out/visual-review.md (skill step 5b)"]),
      ];
      const reason = `Visual review incomplete: ${missing.join("; ")}. Then update agent-out/visual-review.md and finish.`;
      append(input, "stop-blocks.jsonl", { unread, review });
      process.stdout.write(JSON.stringify({ decision: "block", reason }));
    }
  }
} catch (e) {
  process.stderr.write(`visual-gate hook: ${e instanceof Error ? e.message : String(e)}\n`);
}
