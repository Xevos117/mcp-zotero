#!/usr/bin/env node
// Scope of the word-proxy job of test.yml (Zotero desktop + WordCraft on the injected documents): run=true|false.
// Pull requests: only when a changed file affects what Zotero receives (injection, conversion to itemData, the
// product skill, the corpus) or how the job runs; a docs-only PR never starts it. Push to main and manual runs:
// always. A job-level `if`, not `on.paths`, so the rest of test.yml is never filtered.
// Usage: git diff --name-only BASE...HEAD | EVENT=pull_request node scripts/word-proxy-scope.mjs >> "$GITHUB_OUTPUT"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WORD_PROXY_PATHS =
  /^(src\/citation-injector\/|src\/tools\/inject-citations\.ts|src\/utils\/csl-to-zotero\.ts|skills\/zotero-skill-mcp-integrations\/|test\/word-proxy\/|test\/fixtures\/corpus\/|\.github\/actions\/word-tools\/|\.github\/workflows\/test\.yml|scripts\/word-proxy-scope\.mjs|package(-lock)?\.json)/;

export function wordProxyScope(event, changed = []) {
  if (event === "pull_request") return changed.some((f) => WORD_PROXY_PATHS.test(f));
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.EVENT ?? "";
  const changed = event === "pull_request" ? readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  process.stdout.write(`run=${wordProxyScope(event, changed)}\n`);
}
