#!/usr/bin/env node
// Scope of the word-proxy and lo-proxy jobs of test.yml (Zotero desktop + WordCraft / LibreOffice on the injected
// documents): run=true|false for word-proxy, lo=true|false for lo-proxy. Pull requests: only when a changed file can
// affect what Zotero receives (any product source: the documents go through the whole server; the product skill; the
// corpus) or how the job runs; a docs-only PR starts neither. lo-proxy also runs when its own tools change (the
// LibreOffice action, test/lo-proxy) and shares the Zotero download of word-tools. Push to main and manual runs:
// always. A job-level `if`, not `on.paths`, so the rest of test.yml is never filtered.
// Usage: git diff --name-only BASE...HEAD | EVENT=pull_request node scripts/word-proxy-scope.mjs >> "$GITHUB_OUTPUT"
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WORD_PROXY_PATHS =
  /^(src\/|skills\/zotero-skill-mcp-integrations\/|test\/word-proxy\/|test\/fixtures\/corpus\/|\.github\/actions\/word-tools\/|\.github\/workflows\/test\.yml|scripts\/word-proxy-scope\.mjs|package(-lock)?\.json)/;

// lo-proxy mirrors word-proxy, plus its own driver and action; it reuses the word-proxy plugin/corpus and the Zotero
// build downloaded by word-tools, so changes there run it too.
export const LO_PROXY_PATHS =
  /^(src\/|skills\/zotero-skill-mcp-integrations\/|test\/lo-proxy\/|test\/word-proxy\/|test\/fixtures\/corpus\/|\.github\/actions\/(word-tools|libreoffice-tools)\/|\.github\/workflows\/test\.yml|scripts\/word-proxy-scope\.mjs|package(-lock)?\.json)/;

export function wordProxyScope(event, changed = []) {
  if (event === "pull_request") return changed.some((f) => WORD_PROXY_PATHS.test(f));
  return true;
}

export function loProxyScope(event, changed = []) {
  if (event === "pull_request") return changed.some((f) => LO_PROXY_PATHS.test(f));
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.EVENT ?? "";
  const changed = event === "pull_request" ? readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  process.stdout.write(`run=${wordProxyScope(event, changed)}\nlo=${loProxyScope(event, changed)}\n`);
}
