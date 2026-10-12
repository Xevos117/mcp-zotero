#!/usr/bin/env node
// Guard for agent-written text that a workflow publishes (deps PR description, deps issue): fails if it
// contains something that looks like a credential. The agent has no secrets in its environment, but files on
// the runner (e.g. the GitHub OIDC token of the federation exchange) are not out of its reach.
// Usage: node scripts/check-public-text.mjs <file>...   (exit 1 naming the file and the kind, never the match)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PATTERNS = [
  ["JWT (e.g. an OIDC token)", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{10,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}/],
  ["credential in a URL", /x-access-token:[^@\s]+@/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Kinds of credential found in the text (empty if none). */
export function credentialKinds(text) {
  return PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let bad = false;
  for (const file of process.argv.slice(2)) {
    const kinds = credentialKinds(readFileSync(file, "utf8"));
    if (kinds.length) {
      bad = true;
      console.log(`::error::${file}: looks like it contains a credential (${kinds.join(", ")}): not published`);
    }
  }
  process.exit(bad ? 1 : 0);
}
