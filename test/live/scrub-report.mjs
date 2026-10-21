#!/usr/bin/env node
// Copies the live-run outputs into an artifact directory with secrets and identifiers masked:
// API key, user id, username, group id, group name and Unpaywall email (read from the same env as the suite;
// ZOTERO_TEST_GROUP_NAME is set by test/live/mask-group-name.mjs at the start of the job). Fails closed: with a
// test group configured but no group name in the environment, nothing is written.
// Usage: node test/live/scrub-report.mjs <out-dir> <file-or-dir>...
// Missing inputs are skipped; binary files (e.g. .docx) are not copied, only listed.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [outDir, ...inputs] = process.argv.slice(2);
if (!outDir || inputs.length === 0) {
  console.error("usage: scrub-report.mjs <out-dir> <file-or-dir>...");
  process.exit(2);
}

const SECRET_ENV = [
  "ZOTERO_TEST_API_KEY",
  "UNPAYWALL_EMAIL",
  "ZOTERO_TEST_USERNAME",
  "ZOTERO_TEST_USER_ID",
  "ZOTERO_TEST_GROUP_ID",
  "ZOTERO_TEST_GROUP_NAME",
  "ANTHROPIC_API_KEY",
];
if ((process.env.ZOTERO_TEST_GROUP_ID ?? "").trim() && !(process.env.ZOTERO_TEST_GROUP_NAME ?? "").trim()) {
  console.error("scrub-report: ZOTERO_TEST_GROUP_NAME missing (run test/live/mask-group-name.mjs first in this job)");
  process.exit(1);
}
const secrets = SECRET_ENV.map((name) => process.env[name]?.trim())
  .filter((v) => typeof v === "string" && v.length >= 3)
  .sort((a, b) => b.length - a.length);
const scrub = (text) => secrets.reduce((t, s) => t.split(s).join("***"), text);
const TEXT = /\.(json|jsonl|txt|md|log|xml)$/i;

mkdirSync(outDir, { recursive: true });
const skipped = [];
function copy(src, dest) {
  if (statSync(src).isDirectory()) {
    for (const entry of readdirSync(src)) copy(join(src, entry), join(dest, entry));
    return;
  }
  if (!TEXT.test(src)) {
    skipped.push(src);
    return;
  }
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, scrub(readFileSync(src, "utf8")));
}
for (const input of inputs) {
  if (!existsSync(input)) continue;
  copy(input, join(outDir, basename(input)));
}
if (skipped.length) writeFileSync(join(outDir, "not-copied.txt"), scrub(skipped.join("\n") + "\n"));
// Final guard: no secret may survive in the artifact directory.
for (const file of readdirSync(outDir, { recursive: true })) {
  const p = join(outDir, String(file));
  if (statSync(p).isFile() && secrets.some((s) => readFileSync(p, "utf8").includes(s))) {
    console.error(`scrub-report: secret still present in ${p}: output removed`);
    rmSync(outDir, { recursive: true, force: true });
    process.exit(1);
  }
}
console.log(`scrub-report: ${inputs.length} input(s) → ${outDir}`);
