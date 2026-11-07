#!/usr/bin/env node
// Redacts (or restores) the test-account identifiers in agent-out/ so that artifacts passed between the
// agent-smoke jobs never carry them on a public repository:
//   node test/live/agent/redact.mjs redact  <dir>   user id / group id → numeric placeholders, username and
//                                                   group name → fixed tokens, API key / email → ***; fails if
//                                                   any survives
//   node test/live/agent/redact.mjs restore <dir>   placeholders → real user id / group id (for the verifier)
// Text files (.json .jsonl .txt .md .xml) and every XML part of .docx files are processed.
// Env: ZOTERO_TEST_API_KEY, UNPAYWALL_EMAIL, ZOTERO_TEST_USER_ID, ZOTERO_TEST_USERNAME, ZOTERO_TEST_GROUP_ID, and
// ZOTERO_TEST_GROUP_NAME (set by test/live/mask-group-name.mjs): redact fails closed when a group is configured
// without its name.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

const USER_PLACEHOLDER = "100000000000001";
const GROUP_PLACEHOLDER = "200000000000002";
const USERNAME_TOKEN = "mzt-redacted-username";
const GROUP_NAME_TOKEN = "mzt-redacted-group-name";
const TEXT = /\.(json|jsonl|txt|md|xml)$/i;

const [mode, dir] = process.argv.slice(2);
if (!["redact", "restore"].includes(mode) || !dir) {
  console.error("usage: redact.mjs redact|restore <dir>");
  process.exit(2);
}
const env = (name) => (process.env[name] ?? "").trim();
const userId = env("ZOTERO_TEST_USER_ID");
const groupId = env("ZOTERO_TEST_GROUP_ID");
const secrets = [env("ZOTERO_TEST_API_KEY"), env("UNPAYWALL_EMAIL")].filter((s) => s.length >= 4);
const username = env("ZOTERO_TEST_USERNAME");
const groupName = env("ZOTERO_TEST_GROUP_NAME");
if (mode === "redact" && groupId && !groupName) {
  console.error("redact: ZOTERO_TEST_GROUP_NAME missing (run test/live/mask-group-name.mjs first in this job)");
  process.exit(1);
}
const digits = (value) => new RegExp(`(?<!\\d)${value}(?!\\d)`, "g");

function transform(text) {
  if (mode === "restore") {
    let out = text;
    if (userId) out = out.replace(digits(USER_PLACEHOLDER), userId);
    if (groupId) out = out.replace(digits(GROUP_PLACEHOLDER), groupId);
    return out;
  }
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  // longest first: one may contain the other
  for (const [value, token] of [[username, USERNAME_TOKEN], [groupName, GROUP_NAME_TOKEN]].sort((a, b) => b[0].length - a[0].length)) {
    if (value.length >= 3) out = out.split(value).join(token);
  }
  if (/^\d+$/.test(userId)) out = out.replace(digits(userId), USER_PLACEHOLDER);
  if (/^\d+$/.test(groupId)) out = out.replace(digits(groupId), GROUP_PLACEHOLDER);
  return out;
}

function survivors(text) {
  const found = secrets.filter((s) => text.includes(s));
  if (username.length >= 3 && text.includes(username)) found.push("username");
  if (groupName.length >= 3 && text.includes(groupName)) found.push("group name");
  if (/^\d+$/.test(userId) && digits(userId).test(text)) found.push("user id");
  if (/^\d+$/.test(groupId) && digits(groupId).test(text)) found.push("group id");
  return found;
}

const files = readdirSync(dir, { recursive: true })
  .map((f) => join(dir, String(f)))
  .filter((p) => statSync(p).isFile());
const problems = [];
for (const path of files) {
  if (TEXT.test(path)) {
    const out = transform(readFileSync(path, "utf8"));
    writeFileSync(path, out);
    if (mode === "redact" && survivors(out).length) problems.push(path);
  } else if (/\.(docx|odt)$/i.test(path)) {
    // docx (Word) and odt (LibreOffice) are zips whose XML parts hold the URIs with the account id
    let zip = null;
    try {
      zip = await JSZip.loadAsync(readFileSync(path));
    } catch {
      zip = null; // not a real zip (e.g. a placeholder the agent wrote): redact as plain bytes, never crash
    }
    if (zip) {
      for (const part of Object.values(zip.files).filter((f) => !f.dir && /\.(xml|rels)$/.test(f.name))) {
        const out = transform(await part.async("string"));
        zip.file(part.name, out);
        if (mode === "redact" && survivors(out).length) problems.push(`${path}:${part.name}`);
      }
      writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
    } else {
      const out = transform(readFileSync(path, "latin1"));
      writeFileSync(path, out, "latin1");
      if (mode === "redact" && survivors(out).length) problems.push(path);
    }
  } else if (mode === "redact") {
    // unknown binary: refuse to pass it on unless it is clean as raw bytes
    if (survivors(readFileSync(path).toString("latin1")).length) problems.push(path);
  }
}
// Fail-closed final scan (redact only): decompress every file that is a zip and scan all of its parts,
// plus the raw bytes of every other file, for a surviving identifier. This catches an id hiding in a
// compressed part that the per-file pass above did not cover (the leak that odt files slipped through).
if (mode === "redact") {
  for (const path of files) {
    let zip = null;
    try {
      zip = await JSZip.loadAsync(readFileSync(path));
    } catch {
      zip = null;
    }
    if (zip) {
      for (const part of Object.values(zip.files).filter((f) => !f.dir)) {
        if (survivors(await part.async("string")).length) problems.push(`${path}:${part.name} (scan)`);
      }
    } else if (!TEXT.test(path)) {
      if (survivors(readFileSync(path).toString("latin1")).length) problems.push(`${path} (scan)`);
    } else if (survivors(readFileSync(path, "utf8")).length) {
      problems.push(`${path} (scan)`);
    }
  }
}
if (problems.length) {
  console.error(`redact: identifiers still present in ${[...new Set(problems)].length} file(s): ${[...new Set(problems)].join(", ")}`);
  process.exit(1);
}
console.log(`${mode}: ${files.length} file(s) in ${dir}`);
